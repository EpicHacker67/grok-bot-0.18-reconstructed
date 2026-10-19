from pathlib import Path
p=Path('/usr/local/bin/box-xvfb')
s=p.read_text()
old='exec Xvfb "$@"'
assert old in s
s=s.replace(old,'''if [ "$display" = ":2" ]; then
    exec Xorg :2 -config /etc/X11/mengel-xorg.conf -nolisten tcp -noreset -ac -novtswitch -sharevts -logfile /tmp/mengel-xorg.log
fi
exec Xvfb "$@"''')
# The supervisor's recovery must recognize the GPU server as well as Xvfb.
s=s.replace("grep -q 'Xvfb'", "grep -Eq 'Xvfb|Xorg'")
p.write_text(s)
p=Path('/usr/local/bin/start-desktop.sh')
s=p.read_text()
assert '\t-noxdamage\n' in s
s=s.replace('\t-noxdamage\n','\t-defer 3\n\t-wait 5\n')
a=s.index('PICOM_ARGS=(');b=s.index('\n)',a)+2
s=s[:a]+'''# A headless NVIDIA display has no physical vblank source. Picom's frame
# pacing can repaint only once per second while Chrome still reports 60 fps.
PICOM_ARGS=(--backend glx --no-use-damage --no-vsync --no-frame-pacing)'''+s[b:]
s=s.replace('\t--disable-dev-shm-usage\n','')
s=s.replace('if [ "${SAND_CHROME_LEGACY_GPU:-0}" = "1" ]; then', '''if [ "${BOX_DISPLAY_NUM:-1}" = "2" ]; then
    CHROME_FLAGS+=(--use-gl=angle --use-angle=gl --enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist --restore-last-session)
elif [ "${SAND_CHROME_LEGACY_GPU:-0}" = "1" ]; then''')
p.write_text(s)
