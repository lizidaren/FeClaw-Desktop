// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Handle `--right-click <mode> <filepath>` invocations from the Windows shell.
    // The pending file is written to ~/.feclaw/pending-right-click.json and
    // consumed by the GUI once it starts.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--right-click" {
        let mode = &args[2];
        let path = &args[3];
        if let Err(e) = feclaw_desktop_lib::handle_right_click_invocation(mode, path) {
            eprintln!("error handling --right-click: {e:#}");
        }
        // Proceed to normal startup — the pending file will be picked up
        // by lib.rs setup after the GUI boots.
    }

    feclaw_desktop_lib::run();
}
