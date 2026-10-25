//! Windows 冷启动画面。
//!
//! WebView2 从进程启动到画出第一帧要约 0.9 秒，这段时间主窗口连创建都还没完成
//! （窗口是在 WebView2 初始化过程中建出来的）。如果什么都不显示，用户点完图标
//! 会觉得「没反应」。所以进程一起来就在独立线程上开一个原生窗口，自绘启动壳
//! 位图；等前端把壳画出来再交接给主窗口。
//!
//! 位图由 `scripts/capture-boot-shell.mjs` 截取真实启动壳页面生成 —— 两边像素
//! 一致，交接时看到的是同一个画面接着动，而不是窗口切换。

/// 壳位图：由 `scripts/capture-boot-shell.mjs` 从真实启动壳页面截取（2 倍图）。
const SHELL_PNG: &[u8] = include_bytes!("../assets/boot-shell.png");

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, Ordering};
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, CreateCompatibleDC, CreateDIBSection, CreateSolidBrush, DeleteDC, DeleteObject,
        EndPaint, FillRect, GetDC, ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode,
        StretchBlt, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE,
        PAINTSTRUCT, SRCCOPY,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::{
        GetDpiForSystem, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
        GetMessageW, GetSystemMetrics, PostMessageW, PostQuitMessage, RegisterClassW, ShowWindow,
        SystemParametersInfoW, TranslateMessage, MSG, SM_CXSIZEFRAME, SM_CXPADDEDBORDER,
        SM_CYBORDER, SPI_GETWORKAREA, SW_SHOWNOACTIVATE, WM_CLOSE, WM_DESTROY, WM_ERASEBKGND,
        WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    use super::SHELL_PNG;

    /// #07080B 的 COLORREF（0x00BBGGRR）：与启动壳、主窗口底色一致。
    const BACKGROUND: u32 = 0x000B_0807;

    /// 解码后的壳位图（BGRA、自顶向下）。解码放在独立线程，不占启动路径。
    static DECODED: OnceLock<Option<(Vec<u8>, i32, i32)>> = OnceLock::new();

    /// 已经显示出来的窗口；`dismiss` 从别的线程用它投递关闭消息。
    static WINDOW: AtomicIsize = AtomicIsize::new(0);
    /// 关闭请求可能先于窗口创建到达，置位后不再显示。
    static DISMISSED: AtomicBool = AtomicBool::new(false);
    /// 壳位图的内存 DC 与像素尺寸。
    static SHELL_DC: AtomicIsize = AtomicIsize::new(0);
    static SHELL_W: AtomicI32 = AtomicI32::new(0);
    static SHELL_H: AtomicI32 = AtomicI32::new(0);

    pub fn preload() {
        // 我们比 tao 更早创建窗口，得先自己声明 DPI 感知，否则高 DPI 下
        // 坐标会被系统虚拟化。tao 之后重复设置会静默失败，行为不受影响。
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        std::thread::spawn(|| {
            DECODED.get_or_init(decode_shell);
        });
    }

    /// 在主窗口将要占据的客户区上开一个启动窗。
    ///
    /// 几何必须自己算：主窗口要等 WebView2 初始化完才建出来（约 1 秒），
    /// 那时再对齐已经太晚。这里复刻 Tauri 的居中式定位，再补上无边框窗口的
    /// 客户区内缩，让启动窗与主窗口客户区严丝合缝 —— 交接时画面不跳。
    pub fn show(logical_width: f64, logical_height: f64) {
        let scale = unsafe { GetDpiForSystem() } as f64 / 96.0;
        let width = (logical_width * scale).round() as i32;
        let height = (logical_height * scale).round() as i32;

        let mut work = RECT::default();
        unsafe {
            SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut RECT as *mut c_void, 0);
        }
        // Tauri 的无边框窗口仍保留 WS_CAPTION | WS_SIZEBOX，非客户区被收成
        // 「左右各算一档边框、顶部只剩 1 像素边」。两者都随 DPI 缩放。
        let inset_x = unsafe { GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER) };
        let inset_y = unsafe { GetSystemMetrics(SM_CYBORDER) };
        let x = work.left + (work.right - work.left - width) / 2 + inset_x;
        let y = work.top + (work.bottom - work.top - height) / 2 + inset_y;

        std::thread::spawn(move || run(x, y, width, height));
    }

    pub fn dismiss() {
        DISMISSED.store(true, Ordering::SeqCst);
        let raw = WINDOW.load(Ordering::SeqCst);
        if raw != 0 {
            unsafe {
                PostMessageW(raw as HWND, WM_CLOSE, 0, 0);
            }
        }
    }

    /// 主窗口已经显示：留出一两帧让它把首帧呈到屏幕上再撤。
    ///
    /// 撤早了会露出主窗口还没绘制的底色；而「是否已经绘制」在窗口显示之前
    /// 根本观测不到（paint 条目要等窗口可见才产生），所以这里按帧时延兜住。
    pub fn hand_off() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(120));
            dismiss();
        });
    }

    fn run(x: i32, y: i32, width: i32, height: i32) {
        let decoded = DECODED.get_or_init(decode_shell);
        let Some((pixels, shell_w, shell_h)) = decoded.as_ref() else {
            return;
        };

        unsafe {
            let instance = GetModuleHandleW(null());
            let class = wide("PizzicSplash");
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: null_mut(),
                hCursor: null_mut(),
                hbrBackground: null_mut(),
                lpszMenuName: null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);

            let title = wide("Pizzic");
            let hwnd = CreateWindowExW(
                // 置顶：主窗口随后会在它下面显示，先画好首帧，再一次性换过去。
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                x,
                y,
                width,
                height,
                null_mut(),
                null_mut(),
                instance,
                null(),
            );
            if hwnd.is_null() {
                return;
            }

            if let Some(dc) = upload_shell(pixels, *shell_w, *shell_h) {
                SHELL_DC.store(dc as isize, Ordering::SeqCst);
                SHELL_W.store(*shell_w, Ordering::SeqCst);
                SHELL_H.store(*shell_h, Ordering::SeqCst);
            }

            // 前端可能在我们准备好之前就已经就绪，此时不该再闪一下。
            if DISMISSED.load(Ordering::SeqCst) {
                DestroyWindow(hwnd);
                return;
            }

            WINDOW.store(hwnd as isize, Ordering::SeqCst);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            UpdateWindow(hwnd);
        }

        let mut msg: MSG = unsafe { std::mem::zeroed() };
        unsafe {
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    fn decode_shell() -> Option<(Vec<u8>, i32, i32)> {
        let mut reader = png::Decoder::new(std::io::Cursor::new(SHELL_PNG))
            .read_info()
            .ok()?;
        let mut raw = vec![0u8; reader.output_buffer_size()?];
        let info = reader.next_frame(&mut raw).ok()?;
        let (width, height) = (info.width as i32, info.height as i32);
        let channels = match info.color_type {
            png::ColorType::Rgb => 3,
            png::ColorType::Rgba => 4,
            _ => return None,
        };
        // 32bpp 的 DIB 存 BGRA；截图不带透明，alpha 一律写满。
        let mut bgra = Vec::with_capacity(width as usize * height as usize * 4);
        for px in raw[..width as usize * height as usize * channels].chunks_exact(channels) {
            bgra.extend_from_slice(&[px[2], px[1], px[0], 0xff]);
        }
        Some((bgra, width, height))
    }

    /// 把位图放进内存 DC。负高度声明自顶向下，与截图的行序一致。
    unsafe fn upload_shell(pixels: &[u8], width: i32, height: i32) -> Option<*mut c_void> {
        let screen = GetDC(null_mut());
        let mem = CreateCompatibleDC(screen);
        ReleaseDC(null_mut(), screen);
        if mem.is_null() {
            return None;
        }

        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default()],
        };
        let mut bits: *mut c_void = null_mut();
        let bitmap = CreateDIBSection(mem, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        if bitmap.is_null() || bits.is_null() {
            DeleteDC(mem);
            return None;
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u8, pixels.len());
        SelectObject(mem, bitmap);
        Some(mem)
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let dc = BeginPaint(hwnd, &mut ps);

                let mut client = RECT::default();
                GetClientRect(hwnd, &mut client);
                let brush = CreateSolidBrush(BACKGROUND);
                FillRect(dc, &client, brush);
                DeleteObject(brush);

                let shell = SHELL_DC.load(Ordering::SeqCst);
                let (sw, sh) = (SHELL_W.load(Ordering::SeqCst), SHELL_H.load(Ordering::SeqCst));
                if shell != 0 && sw > 0 && sh > 0 {
                    // 位图按窗口实际尺寸缩放：100% 缩放下是 2:1 缩小，
                    // 高 DPI 下按比例放大，两种情况下边缘都还算干净。
                    SetStretchBltMode(dc, HALFTONE);
                    SetBrushOrgEx(dc, 0, 0, null_mut());
                    StretchBlt(
                        dc,
                        0,
                        0,
                        client.right,
                        client.bottom,
                        shell as *mut c_void,
                        0,
                        0,
                        sw,
                        sh,
                        SRCCOPY,
                    );
                }

                EndPaint(hwnd, &mut ps);
                0
            }
            // 整个客户区都由 WM_PAINT 负责，交给系统擦会闪白。
            WM_ERASEBKGND => 1,
            WM_CLOSE => {
                DestroyWindow(hwnd);
                0
            }
            WM_DESTROY => {
                WINDOW.store(0, Ordering::SeqCst);
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// 提前解码壳位图、声明 DPI 感知。可在 Tauri 初始化之前调用。
pub fn preload() {
    #[cfg(windows)]
    imp::preload();
}

/// 在主窗口将要占据的客户区上显示启动画面（尺寸取自窗口配置，逻辑像素）。
pub fn show(logical_width: f64, logical_height: f64) {
    #[cfg(windows)]
    imp::show(logical_width, logical_height);
}

/// 主窗口已显示：等它把首帧呈上来再撤启动画面（幂等，没显示过也安全）。
pub fn hand_off() {
    #[cfg(windows)]
    imp::hand_off();
}
