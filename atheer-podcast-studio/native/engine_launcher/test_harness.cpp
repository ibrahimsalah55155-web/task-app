/*
 * Windows CI test for mag_engine.uxpaddon, outside Premiere.
 *
 * Loads the addon with LoadLibrary, hands it a minimal fake of the UXP addon
 * API table (only the calls the addon uses), then exercises start / isRunning /
 * exitCode / info / stop exactly as the panel does, and checks the engine
 * answers on http://127.0.0.1:<port>/api/v1/health.
 *
 *   test_harness.exe <path-to-addon> <port> stop     -> start, check, stop via terminate()
 *   test_harness.exe <path-to-addon> <port> abandon  -> start, check, exit WITHOUT stopping;
 *                                                      the job object must kill the engine
 * Prints "PID <n>" and exits 0 on success.
 */
#include <windows.h>

#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "UxpAddonShared.h"

struct V {
    int kind = 0;  // 0 undefined, 1 bool, 2 number, 3 string, 4 function, 5 object
    bool b = false;
    double num = 0;
    std::string str;
    addon_callback fn = nullptr;
    std::map<std::string, V*> props;
};
struct Info {
    std::vector<V*> args;
};

static std::string gThrown;
static V* AsV(addon_value v) { return reinterpret_cast<V*>(v); }
static addon_value AsA(V* v) { return reinterpret_cast<addon_value>(v); }

static addon_status get_cb_info(addon_env, addon_callback_info ci, size_t* argc, addon_value* argv, addon_value*, void**) {
    Info* info = reinterpret_cast<Info*>(ci);
    size_t n = *argc;
    for (size_t i = 0; i < n; i++) argv[i] = i < info->args.size() ? AsA(info->args[i]) : AsA(new V());
    *argc = info->args.size();
    return addon_ok;
}
static addon_status throw_error(addon_env, const char*, const char* msg) {
    gThrown = msg ? msg : "error";
    return addon_ok;
}
static addon_status get_value_int32(addon_env, addon_value v, int32_t* r) {
    if (AsV(v)->kind != 2) return addon_number_expected;
    *r = (int32_t)AsV(v)->num;
    return addon_ok;
}
static addon_status get_value_string_utf8(addon_env, addon_value v, char* buf, size_t size, size_t* r) {
    if (AsV(v)->kind != 3) return addon_string_expected;
    const std::string& s = AsV(v)->str;
    if (!buf) {
        *r = s.size();
        return addon_ok;
    }
    size_t n = s.size() < size - 1 ? s.size() : size - 1;
    memcpy(buf, s.data(), n);
    buf[n] = 0;
    *r = n;
    return addon_ok;
}
static addon_status create_function(addon_env, const char*, size_t, addon_callback cb, void*, addon_value* r) {
    V* v = new V();
    v->kind = 4;
    v->fn = cb;
    *r = AsA(v);
    return addon_ok;
}
static addon_status set_named_property(addon_env, addon_value obj, const char* name, addon_value val) {
    AsV(obj)->props[name] = AsV(val);
    return addon_ok;
}
static addon_status get_undefined(addon_env, addon_value* r) {
    *r = AsA(new V());
    return addon_ok;
}
static addon_status get_boolean(addon_env, bool b, addon_value* r) {
    V* v = new V();
    v->kind = 1;
    v->b = b;
    *r = AsA(v);
    return addon_ok;
}
static addon_status create_double(addon_env, double d, addon_value* r) {
    V* v = new V();
    v->kind = 2;
    v->num = d;
    *r = AsA(v);
    return addon_ok;
}
static addon_status create_string_utf8(addon_env, const char* s, size_t n, addon_value* r) {
    V* v = new V();
    v->kind = 3;
    v->str.assign(s, n);
    *r = AsA(v);
    return addon_ok;
}

static V* Call(V* exports, const char* name, std::vector<V*> args) {
    gThrown.clear();
    Info info{args};
    V* f = exports->props[name];
    if (!f) {
        printf("FAIL: export %s missing\n", name);
        exit(10);
    }
    return AsV(f->fn(nullptr, reinterpret_cast<addon_callback_info>(&info)));
}
static V* Num(double d) {
    V* v = new V();
    v->kind = 2;
    v->num = d;
    return v;
}
static V* Str(const std::string& s) {
    V* v = new V();
    v->kind = 3;
    v->str = s;
    return v;
}

static bool HealthOk(int port) {
    std::string cmd = "curl.exe -s --noproxy * -o NUL -w \"%{http_code}\" http://127.0.0.1:" + std::to_string(port) + "/api/v1/health > health.txt";
    system(cmd.c_str());
    FILE* f = fopen("health.txt", "r");
    char buf[8] = {0};
    if (f) {
        fread(buf, 1, 3, f);
        fclose(f);
    }
    return std::string(buf) == "200";
}

int main(int argc, char** argv) {
    if (argc < 4) {
        printf("usage: test_harness <addon> <port> stop|abandon\n");
        return 2;
    }
    int port = atoi(argv[2]);
    bool abandon = std::string(argv[3]) == "abandon";

    HMODULE dll = LoadLibraryA(argv[1]);
    if (!dll) {
        printf("FAIL: LoadLibrary error %lu\n", GetLastError());
        return 3;
    }
    using InitFn = addon_value(__stdcall*)(addon_env, addon_value, addon_apis&&);
    using TermFn = void(__stdcall*)(addon_env);
    auto init = reinterpret_cast<InitFn>(GetProcAddress(dll, "uxp_addon_init"));
    auto term = reinterpret_cast<TermFn>(GetProcAddress(dll, "uxp_addon_terminate"));
    if (!init || !term) {
        printf("FAIL: missing uxp_addon_init/terminate exports\n");
        return 4;
    }

    addon_apis apis = {};
    apis.uxp_addon_get_cb_info = get_cb_info;
    apis.uxp_addon_throw_error = throw_error;
    apis.uxp_addon_get_value_int32 = get_value_int32;
    apis.uxp_addon_get_value_string_utf8 = get_value_string_utf8;
    apis.uxp_addon_create_function = create_function;
    apis.uxp_addon_set_named_property = set_named_property;
    apis.uxp_addon_get_undefined = get_undefined;
    apis.uxp_addon_get_boolean = get_boolean;
    apis.uxp_addon_create_double = create_double;
    apis.uxp_addon_create_string_utf8 = create_string_utf8;

    V* exports = new V();
    exports->kind = 5;
    init(nullptr, AsA(exports), std::move(apis));
    printf("info: %s\n", Call(exports, "info", {})->str.c_str());

    // Bad input is rejected, not executed.
    Call(exports, "start", {Num(80), Str("short")});
    if (gThrown.empty()) {
        printf("FAIL: invalid port/token accepted\n");
        return 5;
    }

    V* pid = Call(exports, "start", {Num(port), Str("ci-session-token-0123456789abcdef")});
    if (!gThrown.empty()) {
        printf("FAIL: start threw: %s\n", gThrown.c_str());
        return 6;
    }
    printf("PID %d\n", (int)pid->num);
    fflush(stdout);

    bool up = false;
    for (int i = 0; i < 120 && !up; i++) {
        Sleep(500);
        if (!Call(exports, "isRunning", {})->b) {
            printf("FAIL: engine exited with code %d\n", (int)Call(exports, "exitCode", {})->num);
            return 7;
        }
        up = HealthOk(port);
    }
    if (!up) {
        printf("FAIL: engine did not answer on port %d\n", port);
        return 8;
    }
    printf("engine healthy on port %d\n", port);

    // Starting twice returns the same process.
    V* again = Call(exports, "start", {Num(port), Str("ci-session-token-0123456789abcdef")});
    if ((int)again->num != (int)pid->num) {
        printf("FAIL: second start launched another engine\n");
        return 9;
    }

    if (abandon) {
        printf("exiting without stop; the job object must kill the engine\n");
        return 0;
    }
    term(nullptr);  // what UXP does when the plugin unloads
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)pid->num);
    if (h && WaitForSingleObject(h, 5000) != WAIT_OBJECT_0) {
        printf("FAIL: engine still running after terminate\n");
        return 11;
    }
    if (h) CloseHandle(h);
    printf("OK: engine stopped by terminate()\n");
    return 0;
}
