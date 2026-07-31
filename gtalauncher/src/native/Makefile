# GTAMP Native components - MinGW-w64 cross-compile for Windows x64
# Builds: gtamp_injector.exe, gtamp_hook.dll
# (portable packaging is handled by electron-builder now; we no longer need our own stub)

CROSS := x86_64-w64-mingw32-g++-win32
WINDRES := x86_64-w64-mingw32-windres

CXXFLAGS := -O2 -s -std=c++17 -static -static-libgcc -static-libstdc++ \
            -Wall -Wextra -Wno-unused-parameter -mwindows -DUNICODE -D_UNICODE
DLLFLAGS := -shared
OUT := ../../dist-bin

.PHONY: all clean
all: $(OUT)/gtamp_injector.exe $(OUT)/gtamp_hook.dll

$(OUT):
	mkdir -p $(OUT)

# ---- Injector: CreateRemoteThread + LoadLibrary, waits for target process ----
# Windows GUI subsystem (no console popup) - entry point is wmain via WinMain linkage
$(OUT)/gtamp_injector.exe: injector/main.cpp | $(OUT)
	$(CROSS) -O2 -s -std=c++17 -static -static-libgcc -static-libstdc++ \
	    -Wall -Wno-unused-parameter -municode -mwindows -DUNICODE -D_UNICODE \
	    -o $@ $< -lpsapi

# ---- Hook DLL: loads into GTA5.exe, connects back to bridge over TCP ----
# Phase 1: build detection + safe overlay window + heartbeat
$(OUT)/gtamp_hook.dll: hook/dllmain.cpp | $(OUT)
	$(CROSS) $(CXXFLAGS) $(DLLFLAGS) -o $@ $< -lws2_32 -lpsapi -lversion -lwinmm

clean:
	rm -rf obj $(OUT)/*.exe $(OUT)/*.dll
