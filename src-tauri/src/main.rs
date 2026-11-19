// 开发者本地桌面工具：像 Word 一样可视化编辑 HTML。
// 自定义命令：全局配置读写、本机 Agent 发现、Agent 调用（外部调用入口）。
// 注意：本文件在 Tauri v2 下用 `cargo tauri build` 编译；本仓库的 Node 测试不覆盖 Rust 侧。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Agent CLI 最长执行时间（秒）。超时自动终止子进程并返回错误，
/// 避免 Agent 卡住时界面一直转圈；原文件未改动，备份保留可稍后重试。
const AGENT_TIMEOUT_SECS: u64 = 600;

/// 全局配置落盘位置：应用配置目录下的 config.json（不写进 HTML、不含明文凭证）。
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法获取配置目录：{e}"))?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn read_config(app: tauri::AppHandle) -> Option<String> {
    let path = config_path(&app).ok()?;
    fs::read_to_string(path).ok()
}

#[tauri::command]
fn write_config(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct AgentInfo {
    id: String,
    name: String,
    path: String,
    cmd: String,
}

/// 在 PATH 里发现已知 Agent 可执行程序（不启动、不读取凭证）。
#[tauri::command]
fn discover_agents() -> Vec<AgentInfo> {
    let mut out = Vec::new();
    if let Ok(path_env) = std::env::var("PATH") {
        for bin in ["codex", "cbc", "codebuddy", "workbuddy", "dsh", "cloud-cli"] {
            for dir in path_env.split(':') {
                let p = PathBuf::from(dir).join(bin);
                if p.exists() {
                    out.push(AgentInfo {
                        id: bin.to_string(),
                        name: bin.to_string(),
                        path: p.to_string_lossy().to_string(),
                        cmd: format!("{bin} <instruction>"),
                    });
                    break;
                }
            }
        }
    }
    out
}

/// 临时工作目录守卫：函数返回（含各种提前 return）时自动删除，
/// 避免把 Agent 子进程产生的临时文件留在系统里。
struct TempWorkDir(PathBuf);
impl Drop for TempWorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Agentic 编辑：把真实文件交给本机 Agent，让它像桌面版「添加文件」一样
/// 自己读文件、按指令修改并直接保存。调用前备份原文件，失败/改错可还原。
///
/// 关键隔离：子进程 cwd 用【干净的临时目录】，而不是目标文件所在目录。
/// 否则 codex 会按 cwd 自动加载文件目录里的 AGENTS.md / .ccg/tasks，
/// 把「局部改一处」劫持成「完成整个项目」（曾据此把整页 HTML 重写成信息图）。
/// 目标文件始终用绝对路径传给 Agent，与 cwd 无关。
///
/// agent_id 决定用哪条 CLI：
/// - codex      -> codex exec -s workspace-write --dangerously-bypass-approvals-and-sandbox [-i 截图] <prompt>
/// - workbuddy/codebuddy/cbc -> cbc -p <prompt> -y （cwd=临时目录）
#[tauri::command]
async fn agent_edit_file(
    file_path: String,
    instruction: String,
    agent_id: String,
    screenshot_path: Option<String>,
    selection: Option<String>,
) -> Value {
    let path = Path::new(&file_path);
    if !path.is_absolute() || !path.is_file() {
        return json!({ "ok": false, "error": format!("文件不存在或不是绝对路径：{file_path}") });
    }
    let dir = match path.parent() {
        Some(d) => d,
        None => return json!({ "ok": false, "error": "无法取得文件所在目录" }),
    };

    // 调用前备份：同名 + .hve-backup-<时间戳>，失败可一键还原
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup = path.with_extension(format!(
        "{}.hve-backup-{}.html",
        path.extension().and_then(|e| e.to_str()).unwrap_or("html"),
        stamp
    ));
    if let Err(e) = fs::copy(path, &backup) {
        return json!({ "ok": false, "error": format!("备份原文件失败：{e}") });
    }
    // 记录改动前的内容，调用结束后据此判断 Agent 是否真的写了文件
    let before = fs::read(path).unwrap_or_default();

    // 创建干净的临时工作目录作为子进程 cwd：切断「按文件目录自动加载 AGENTS.md/.ccg 任务」的链路。
    // 目标文件用绝对路径传给 Agent，cwd 改成哪里都不影响它读写目标文件。
    let work_dir = std::env::temp_dir().join(format!("hve-agent-work-{}-{}", std::process::id(), stamp));
    if let Err(e) = fs::create_dir_all(&work_dir) {
        return json!({ "ok": false, "error": format!("创建临时工作目录失败：{e}") });
    }
    let _work_guard = TempWorkDir(work_dir.clone());

    // 任务式提示词：让 Agent 读指定文件、按指令改、直接保存原文件。
    // 给绝对路径，避免工作目录歧义；明确「只改相关部分、直接保存、不要只给建议」。
    let file_display = path.to_string_lossy();
    // 用户在界面上选中的节点上下文（路径 / 标签 / 原文），是「我选择内容」的唯一权威指代。
    // 没有它，codex 只能自己猜目标，曾把 02 节的修改错改到 07 节。
    let selection_block = match selection.as_deref() {
        Some(s) if !s.trim().is_empty() => format!(
            "\n【最重要 — 唯一修改目标】用户在界面上选中了下面这个元素，指令里的「我选择内容 / 当前表格 / 这里」都只指它，绝对不要改到别处：\n{s}\n\
             请先用上面的 DOM 路径或原文片段在源码里定位到这唯一一处，再只改这一处；其他章节里相似的内容一律不动。\n"
        ),
        _ => String::new(),
    };
    let task = format!(
        "请直接编辑文件：{file_display}\n\
         先完整读取这个文件，然后严格按照下面的要求修改它，并把修改直接保存回原文件（覆盖保存）。\n\
         {selection_block}\
         要求：{instruction}\n\
         注意：这是一次【局部定点编辑】，不是重写页面：\n\
         - 只修改与上述要求直接相关的那一处/那一块，其余所有内容、标题、章节、样式、脚本、导航结构必须与原文逐字节保持一致；\n\
         - 严禁使用 cat > / 重定向 / 整文件覆盖的方式写回；必须用字符串替换或 apply_patch 只改动目标片段，文件其余部分一字节都不能动；\n\
         - 严禁重写整个文件、严禁更换整体设计/主题/标题、严禁删减或重排原有章节；\n\
         - 需要替换图表时，只替换该图表对应的节点，不要把它扩展成整页信息图；\n\
         - 本任务与任何 AGENTS.md、.ccg、项目工作流、外部模型审查无关：不要创建任务、不要调用其它模型、不要写其它文件，只执行上面这一条要求；\n\
         - 不要只输出建议或代码片段，必须真正写入文件；完成后简要说明改了什么。"
    );

    let built = build_agent_command(&agent_id, &task, dir, screenshot_path.as_deref());
    let (program, args, use_cbc_style) = match built {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e, "backup": backup.to_string_lossy() }),
    };
    // GUI 环境 PATH 不含 homebrew，裸名解析成绝对路径，并给子进程补 PATH，
    // 否则 `#!/usr/bin/env node` 找不到 node。
    let program_path = resolve_program(&program);
    let child_path = augmented_path();

    let mut cmd = Command::new(&program_path);
    cmd.args(&args)
        // 用干净临时目录而非文件所在目录：避免 codex 加载文件目录里的
        // AGENTS.md / .ccg/tasks 把局部编辑劫持成整页重写。目标文件是绝对路径，不受影响。
        .current_dir(&work_dir)
        .env("PATH", &child_path)
        // 关键：阻止 codex 的 CCG UserPromptSubmit hook 把「局部编辑」劫持成
        // .ccg/tasks 里的完整项目工作流（曾导致整页被重写 + 弹出 codeagent-wrapper 的 Web UI）。
        // 设了 CODEX_AGENT_TYPE 后，hook 的 is_sub_agent() 命中，改为注入
        // SUB_AGENT_NOTICE：「只执行指定任务、忽略工作流、不调用外部模型、只改列出的文件」。
        .env("CODEX_AGENT_TYPE", "hve-editor")
        .env("CODEX_FORK_TURNS", "none")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // 异步命令在 tokio 线程池执行，不占用 UI 主线程；再套超时，避免 Agent 卡住时界面一直转圈。
    let output = match timeout(Duration::from_secs(AGENT_TIMEOUT_SECS), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return json!({
                "ok": false,
                "error": format!("启动 Agent「{program}」失败：{e}。请确认本机已安装并登录该 Agent。"),
                "backup": backup.to_string_lossy()
            })
        }
        Err(_) => {
            return json!({
                "ok": false,
                "error": format!("Agent「{program}」执行超过 {AGENT_TIMEOUT_SECS} 秒仍未完成，已自动终止。界面已恢复可操作，原文件未改动（备份已保留），请检查 Agent 客户端后重试。"),
                "backup": backup.to_string_lossy()
            })
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{stdout}\n{stderr}").to_lowercase();
    let auth_failed = combined.contains("authentication required")
        || combined.contains("please use /login")
        || combined.contains("not logged in")
        || combined.contains("unauthorized")
        || combined.contains("需要登录")
        || combined.contains("未登录");
    if !output.status.success() {
        let brief: String = stderr.chars().take(800).collect();
        return json!({
            "ok": false,
            "error": format!("Agent 执行失败（退出码 {:?}）：{brief}", output.status.code()),
            "backup": backup.to_string_lossy(),
            "stdout": stdout,
            "stderr": stderr
        });
    }
    if auth_failed {
        return json!({
            "ok": false,
            "error": format!("Agent「{program}」未登录，无法修改文件。请在终端运行登录命令（codex 用 `codex login`；workbuddy/codebuddy 用 `cbc /login` 或在桌面版登录后重试）。原始输出：{}",
                combined.chars().take(300).collect::<String>()),
            "backup": backup.to_string_lossy(),
            "stdout": stdout,
            "stderr": stderr
        });
    }
    // 关键验证：不看退出码，看文件是否真的被改动。
    // cbc 未登录等场景会以 0 退出但不写文件，必须以此为准，避免误报成功。
    let after = fs::read(path).unwrap_or_default();
    if after == before {
        return json!({
            "ok": false,
            "error": format!("Agent 执行结束但未修改文件（文件没有任何变化）。可能未登录、无写权限，或认为无需修改。请检查 Agent 登录状态与指令。程序输出：{}",
                combined.chars().take(300).collect::<String>()),
            "backup": backup.to_string_lossy(),
            "stdout": stdout,
            "stderr": stderr
        });
    }
    let _ = use_cbc_style;
    json!({
        "ok": true,
        "message": "Agent 已直接修改并保存文件",
        "backup": backup.to_string_lossy(),
        "stdout": stdout,
        "stderr": stderr
    })
}

/// GUI 应用从 Finder/Dock 启动时不会继承 shell 的 PATH（launchctl getenv PATH 为空），
/// 因此裸名 `cbc`/`codex` 找不到。这里把裸命令解析成绝对路径：先按当前 PATH 找，
/// 再按常见安装位置找；找不到则原样返回（由启动报错给出提示）。
fn resolve_program(program: &str) -> String {
    if program.contains('/') {
        return program.to_string();
    }
    // 1) 当前进程 PATH
    if let Some(p) = which_in_path(program, &std::env::var("PATH").unwrap_or_default()) {
        return p;
    }
    // 2) GUI 环境常见路径（Homebrew / 本地 / 用户 bin）
    let mut dirs: Vec<String> = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        for sub in [".local/bin", ".cargo/bin", ".codebuddy/bin", "bin"] {
            dirs.push(Path::new(&home).join(sub).to_string_lossy().to_string());
        }
    }
    for d in dirs {
        if let Some(p) = which_in_path(program, &d) {
            return p;
        }
    }
    program.to_string()
}

fn which_in_path(program: &str, path_var: &str) -> Option<String> {
    for dir in path_var.split(':') {
        if dir.is_empty() { continue; }
        let candidate = Path::new(dir).join(program);
        if candidate.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(md) = fs::metadata(&candidate) {
                    if md.permissions().mode() & 0o111 != 0 {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
            #[cfg(not(unix))]
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// 构造给 Agent 子进程的 PATH：保留当前 PATH，并补上常见安装目录，
/// 使 shebang `#!/usr/bin/env node` 能找到 node。
fn augmented_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let mut extra = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        for sub in [".local/bin", ".cargo/bin", ".codebuddy/bin", "bin"] {
            extra.push(Path::new(&home).join(sub).to_string_lossy().to_string());
        }
    }
    for e in extra {
        if !parts.contains(&e) { parts.push(e); }
    }
    parts.join(":")
}

/// 根据 agent_id 构造真正 agentic 的命令行参数。
/// 返回 (可执行程序, 参数列表, 是否为 cbc 风格)。
fn build_agent_command(
    agent_id: &str,
    task: &str,
    _dir: &Path,
    screenshot: Option<&str>,
) -> Result<(String, Vec<String>, bool), String> {
    match agent_id {
        "codex" => {
            let mut args: Vec<String> = vec![
                "exec".into(),
                "-s".into(),
                "workspace-write".into(),
                "--dangerously-bypass-approvals-and-sandbox".into(),
                "--skip-git-repo-check".into(),
            ];
            if let Some(img) = screenshot {
                args.push("-i".into());
                args.push(img.to_string());
            }
            args.push(task.to_string());
            Ok(("codex".into(), args, false))
        }
        // workbuddy 桌面版的 CLI 入口就是 codebuddy / cbc
        "workbuddy" | "codebuddy" | "cbc" => {
            let mut args: Vec<String> = vec!["-p".into(), task.to_string(), "-y".into()];
            if let Some(img) = screenshot {
                // cbc 通过 stdin 注入图片路径作为上下文提示
                args.insert(2, format!("参考截图：{img}"));
            }
            Ok(("cbc".into(), args, true))
        }
        _ => Err(format!(
            "未知或不支持 agentic 编辑的 Agent「{agent_id}」。请使用 codex 或 workbuddy。"
        )),
    }
}

/// 还原 agentic 编辑前的备份文件。
#[tauri::command]
fn restore_agent_backup(file_path: String, backup_path: String) -> Value {
    let target = Path::new(&file_path);
    let backup = Path::new(&backup_path);
    if !backup.is_file() {
        return json!({ "ok": false, "error": "备份文件不存在" });
    }
    match fs::copy(backup, target) {
        Ok(_) => json!({ "ok": true, "message": "已还原到 Agent 修改前的文件" }),
        Err(e) => json!({ "ok": false, "error": format!("还原失败：{e}") }),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_config,
            write_config,
            discover_agents,
            agent_edit_file,
            restore_agent_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
