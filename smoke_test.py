# -*- coding: utf-8 -*-
"""端到端冒烟：菜单 -> 套利表 -> 任务列表(搜索/详情/地图链接) -> 退出。"""
import sys, time, threading
from winpty import PtyProcess

EXE = r"C:\Users\11211\PycharmProjects\TarkovTool\build\tarkov-tool.exe"

buf = bytearray()
lock = threading.Lock()
proc = PtyProcess.spawn([EXE], dimensions=(40, 160))
stop = threading.Event()

def reader():
    while not stop.is_set():
        try:
            data = proc.read(4096)
        except Exception:
            break
        if not data:
            break
        if isinstance(data, str):
            data = data.encode("utf-8", "ignore")
        with lock:
            buf.extend(data)

threading.Thread(target=reader, daemon=True).start()

mark = 0  # 只断言 mark 之后的新输出

def fresh_text():
    with lock:
        return bytes(buf[mark:]).decode("utf-8", "ignore")

def new_mark():
    global mark
    with lock:
        mark = len(buf)

def wait_fresh(token, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if token in fresh_text():
            return True
        if not proc.isalive():
            return False
        time.sleep(0.2)
    return False

def send(s, delay=0.6):
    proc.write(s)
    time.sleep(delay)

fails = []
def check(name, ok):
    print(("PASS" if ok else "FAIL"), name, flush=True)
    if not ok:
        fails.append(name)

# 1. 菜单出现，回车进套利表
check("menu shown", wait_fresh("选择工具", 60))
new_mark()
send("\r")
check("flea table shown", wait_fresh("利润", 120))
check("hyperlink OSC8 present", "\x1b]8;" in fresh_text() and "tarkov.dev/item/" in fresh_text())
send("\x1b")
check("back to menu", wait_fresh("选择工具", 30))

# 2. ↓x2 进任务列表，搜索 first，回车看详情
new_mark()
send("\x1b[B")
send("\x1b[B")
send("\r", 1.0)
check("task list shown", wait_fresh("Kappa", 120))
send("first in line", 1.5)
check("task search filters", wait_fresh("新手上路", 15))
new_mark()
send("\r", 1.0)
check("task detail shown", wait_fresh("Wiki:", 15))
check("detail map link", "map.dancingsnow.xyz" in fresh_text()
      and "map=ground-zero" in fresh_text()
      and "q=Sandbox_1_MedicalArea_exploration" in fresh_text())
send("\x1b", 0.8)  # 详情返回列表
send("\x1b", 0.8)  # 列表返回菜单
check("back to menu again", wait_fresh("选择工具", 30))

# 3. ↓x5 到退出（菜单共 6 项），回车
new_mark()
for _ in range(5):
    send("\x1b[B")
send("\r", 1.0)
end = time.time() + 20
exited = False
while time.time() < end:
    if not proc.isalive():
        exited = True
        break
    time.sleep(0.3)
check("process exits after choosing quit", exited)

stop.set()
try:
    proc.terminate()
except Exception:
    pass

if fails:
    sys.stdout.buffer.write(b"---- fresh output tail ----\n")
    sys.stdout.buffer.write(fresh_text()[-3000:].encode("utf-8", "replace"))
    sys.stdout.buffer.write(b"\n")
    sys.exit(1)
print("ALL PASS")
