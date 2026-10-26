#![cfg_attr(all(target_os = "windows", not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    if let Ok(password) = std::env::var("TERMIO_ASKPASS_PASSWORD") {
        print!("{password}");
        return;
    }
    termio_lib::run();
}
