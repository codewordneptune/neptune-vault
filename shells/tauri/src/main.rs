// The desktop entry point. Everything it does is in the library, so that
// Android and iOS, which load a library rather than run a binary, start the
// same app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vault_shell_lib::run()
}
