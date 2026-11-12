/*
 * Multimedia & AI Group - engine launcher (UXP Hybrid addon, Windows x64).
 *
 * Starts the local processing engine that ships INSIDE the plugin folder,
 * without a console window, and guarantees it stops with Premiere:
 *  - CREATE_NO_WINDOW: nothing appears on screen;
 *  - a Job Object with KILL_ON_JOB_CLOSE: if Premiere exits or crashes,
 *    Windows kills the engine;
 *  - the session token travels in the child's environment block, never on
 *    the command line.
 *
 * Only the engine inside this plugin's own folder can be started:
 *   <plugin>\win\x64\mag_engine.uxpaddon   (this file)
 *   <plugin>\engine\python\pythonw.exe     (signed CPython, embeddable build)
 *
 * JavaScript API (all synchronous, all return quickly):
 *   start(port: number, token: string) -> number   pid; throws on failure
 *   isRunning() -> boolean
 *   exitCode() -> number                           -1 while running / never started
 *   stop() -> void
 *   info() -> string                               JSON with paths, for diagnostics
 */

#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "UxpAddon.h"

namespace {

#ifdef _WIN32
HANDLE gJob = nullptr;
HANDLE gProcess = nullptr;
DWORD gPid = 0;
std::wstring gLastError;

std::wstring Widen(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
    return w;
}

std::string Narrow(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

std::wstring ParentDir(const std::wstring& path) {
    size_t i = path.find_last_of(L"\\/");
    return i == std::wstring::npos ? path : path.substr(0, i);
}

// <plugin> = three levels above this DLL: <plugin>\win\x64\mag_engine.uxpaddon
std::wstring PluginRoot() {
    HMODULE self = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCWSTR>(&PluginRoot), &self);
    wchar_t buf[MAX_PATH * 4];
    DWORD len = GetModuleFileNameW(self, buf, (DWORD)(sizeof(buf) / sizeof(buf[0])));
    std::wstring dll(buf, len);
    return ParentDir(ParentDir(ParentDir(dll)));
}

bool FileExists(const std::wstring& p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

bool Running() {
    if (!gProcess) return false;
    return WaitForSingleObject(gProcess, 0) == WAIT_TIMEOUT;
}

std::wstring Quote(const std::wstring& s) { return L"\"" + s + L"\""; }

// Copy of this process's environment plus MAG_ENGINE_TOKEN=<token>, sorted rules not required.
std::wstring BuildEnvironment(const std::wstring& token) {
    std::wstring block;
    LPWCH env = GetEnvironmentStringsW();
    for (LPWCH p = env; p && *p; p += wcslen(p) + 1) {
        std::wstring entry(p);
        if (_wcsnicmp(entry.c_str(), L"MAG_ENGINE_TOKEN=", 17) == 0) continue;
        if (_wcsnicmp(entry.c_str(), L"PYTHONHOME=", 11) == 0) continue;  // never let a user Python leak in
        if (_wcsnicmp(entry.c_str(), L"PYTHONPATH=", 11) == 0) continue;
        block += entry;
        block.push_back(L'\0');
    }
    if (env) FreeEnvironmentStringsW(env);
    block += L"MAG_ENGINE_TOKEN=" + token;
    block.push_back(L'\0');
    block += L"PYTHONIOENCODING=utf-8";
    block.push_back(L'\0');
    block.push_back(L'\0');
    return block;
}

void StopEngine() {
    if (gJob) TerminateJobObject(gJob, 0);
    if (gProcess) {
        WaitForSingleObject(gProcess, 3000);
        CloseHandle(gProcess);
        gProcess = nullptr;
    }
    gPid = 0;
}

DWORD StartEngine(int port, const std::wstring& token) {
    if (Running()) return gPid;
    if (gProcess) {
        CloseHandle(gProcess);
        gProcess = nullptr;
    }
    const std::wstring root = PluginRoot();
    const std::wstring engine = root + L"\\engine";
    const std::wstring python = engine + L"\\python\\pythonw.exe";
    if (!FileExists(python)) {
        gLastError = L"Engine not found at " + python;
        return 0;
    }

    if (!gJob) {
        gJob = CreateJobObjectW(nullptr, nullptr);
        if (gJob) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(gJob, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
        }
    }

    std::wstring cmd = Quote(python) + L" -m atheer_companion"
        + L" --port " + std::to_wstring(port)
        + L" --parent-pid " + std::to_wstring(GetCurrentProcessId())
        + L" --token-env MAG_ENGINE_TOKEN"
        + L" --ffmpeg " + Quote(engine + L"\\ffmpeg\\ffmpeg.exe")
        + L" --ffprobe " + Quote(engine + L"\\ffmpeg\\ffprobe.exe");
    std::wstring env = BuildEnvironment(token);

    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {};
    std::wstring mutableCmd = cmd;  // CreateProcessW may modify the buffer
    BOOL ok = CreateProcessW(python.c_str(), &mutableCmd[0], nullptr, nullptr, FALSE,
                             CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                             &env[0], engine.c_str(), &si, &pi);
    if (!ok) {
        gLastError = L"CreateProcess failed, error " + std::to_wstring(GetLastError());
        return 0;
    }
    // Assign to the job before it runs any code, so it can never outlive Premiere.
    if (gJob) AssignProcessToJobObject(gJob, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    gProcess = pi.hProcess;
    gPid = pi.dwProcessId;
    gLastError.clear();
    return gPid;
}
#endif

std::string GetString(addon_env env, addon_value v) {
    size_t len = 0;
    Check(UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, nullptr, 0, &len));
    std::string s(len, '\0');
    Check(UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, &s[0], len + 1, &len));
    s.resize(len);
    return s;
}

addon_value Start(addon_env env, addon_callback_info info) {
    size_t argc = 2;
    addon_value argv[2];
    if (UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != addon_ok || argc < 2) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "start(port, token) needs two arguments");
        return nullptr;
    }
    int32_t port = 0;
    if (UxpAddonApis.uxp_addon_get_value_int32(env, argv[0], &port) != addon_ok || port < 1024 || port > 65535) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "invalid port");
        return nullptr;
    }
    std::string token;
    try {
        token = GetString(env, argv[1]);
    } catch (...) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "invalid token");
        return nullptr;
    }
    if (token.size() < 16 || token.size() > 200 || token.find_first_of(" \t\r\n\"=") != std::string::npos) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "token must be 16-200 characters without spaces");
        return nullptr;
    }
#ifdef _WIN32
    DWORD pid = StartEngine(port, Widen(token));
    if (!pid) {
        std::string msg = Narrow(gLastError);
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, msg.c_str());
        return nullptr;
    }
    addon_value result;
    UxpAddonApis.uxp_addon_create_double(env, (double)pid, &result);
    return result;
#else
    UxpAddonApis.uxp_addon_throw_error(env, nullptr, "The built-in engine is available on Windows only");
    return nullptr;
#endif
}

addon_value IsRunning(addon_env env, addon_callback_info) {
    addon_value result;
#ifdef _WIN32
    UxpAddonApis.uxp_addon_get_boolean(env, Running(), &result);
#else
    UxpAddonApis.uxp_addon_get_boolean(env, false, &result);
#endif
    return result;
}

addon_value ExitCode(addon_env env, addon_callback_info) {
    double code = -1;
#ifdef _WIN32
    DWORD c = 0;
    if (gProcess && !Running() && GetExitCodeProcess(gProcess, &c)) code = (double)c;
#endif
    addon_value result;
    UxpAddonApis.uxp_addon_create_double(env, code, &result);
    return result;
}

addon_value Stop(addon_env env, addon_callback_info) {
#ifdef _WIN32
    StopEngine();
#endif
    addon_value undef;
    UxpAddonApis.uxp_addon_get_undefined(env, &undef);
    return undef;
}

std::string JsonEscape(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '\\' || c == '"') o.push_back('\\');
        o.push_back(c);
    }
    return o;
}

addon_value Info(addon_env env, addon_callback_info) {
    std::string json = "{\"addon\":\"mag_engine\",\"version\":\"0.2.0\"";
#ifdef _WIN32
    std::wstring root = PluginRoot();
    json += ",\"pluginRoot\":\"" + JsonEscape(Narrow(root)) + "\"";
    json += ",\"engineFound\":" + std::string(FileExists(root + L"\\engine\\python\\pythonw.exe") ? "true" : "false");
    json += ",\"ffmpegFound\":" + std::string(FileExists(root + L"\\engine\\ffmpeg\\ffprobe.exe") ? "true" : "false");
    json += ",\"pid\":" + std::to_string(gPid);
    json += ",\"lastError\":\"" + JsonEscape(Narrow(gLastError)) + "\"";
#endif
    json += "}";
    addon_value result;
    UxpAddonApis.uxp_addon_create_string_utf8(env, json.c_str(), json.size(), &result);
    return result;
}

void Export(addon_env env, addon_value exports, const char* name, addon_callback fn) {
    addon_value f;
    if (UxpAddonApis.uxp_addon_create_function(env, name, strlen(name), fn, nullptr, &f) != addon_ok ||
        UxpAddonApis.uxp_addon_set_named_property(env, exports, name, f) != addon_ok) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "Unable to export function");
    }
}

addon_value Init(addon_env env, addon_value exports, const addon_apis&) {
    Export(env, exports, "start", Start);
    Export(env, exports, "isRunning", IsRunning);
    Export(env, exports, "exitCode", ExitCode);
    Export(env, exports, "stop", Stop);
    Export(env, exports, "info", Info);
    return exports;
}

}  // namespace

UXP_ADDON_INIT(Init)

void Terminate(addon_env) {
#ifdef _WIN32
    StopEngine();
    if (gJob) {
        CloseHandle(gJob);
        gJob = nullptr;
    }
#endif
}

UXP_ADDON_TERMINATE(Terminate)
