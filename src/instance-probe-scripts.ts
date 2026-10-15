export const mailboxPidScript = String.raw`
import json, subprocess
result = {}
for unit in ('celld-celld.service', 'celld-seaweedfs.service'):
    text = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ActiveState,MainPID'], check=True, capture_output=True, text=True).stdout
    fields = dict(line.split('=', 1) for line in text.splitlines())
    if fields.get('ActiveState') != 'active' or int(fields.get('MainPID', '0')) <= 0:
        raise ValueError('Mailbox must be active before probe')
    result[unit] = int(fields['MainPID'])
print(json.dumps(result))
`;

export const instanceGoneScript = String.raw`
import glob, json, os, re, subprocess, sys
home, data, before = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
failed = False
def check(label, clean):
    global failed
    print(('PASS ' if clean else 'FAIL ') + label)
    failed |= not clean
def command(*args):
    result = subprocess.run(args, check=False, text=True, capture_output=True)
    if result.returncode == 1 and args[:3] == ('systemctl', '--user', 'list-unit-files') and not result.stdout.strip():
        return result.stdout
    result.check_returncode()
    return result.stdout
try:
    files = command('systemctl', '--user', 'list-unit-files', 'mischiefrb-*', '--no-legend', '--no-pager')
    loaded = command('systemctl', '--user', 'list-units', '--all', 'mischiefrb-*', 'mischiefrb.slice', '--no-legend', '--no-pager')
    slices = command('systemctl', '--user', 'list-unit-files', 'mischiefrb.slice', '--no-legend', '--no-pager')
    check('instance units absent', not files.strip() and not loaded.strip() and not slices.strip() and not glob.glob(home + '/.config/systemd/user/mischiefrb*'))
    check('wants links absent', not glob.glob(home + '/.config/systemd/user/*.wants/mischiefrb*'))
    listeners = command('ss', '-H', '-ltn')
    ports = {int(match.group(1)) for row in listeners.splitlines() if (match := re.search(r':(\d+)$', row.split()[3]))}
    check('ports 28010-28019 closed', ports.isdisjoint(range(28010, 28020)))
    for label, path in [('configuration and staging absent', home + '/.config/mischiefrb'), ('binary root absent', home + '/.local/share/mischiefrb'), ('data root absent', data), ('S3 socket absent', '/tmp/seaweedfs-s3-28016.sock'), ('S3 gRPC socket absent', '/tmp/seaweedfs-s3-grpc-28017.sock')]:
        check(label, not os.path.lexists(path))
    for unit in ('celld-celld.service', 'celld-seaweedfs.service'):
        fields = dict(line.split('=', 1) for line in command('systemctl', '--user', 'show', unit, '--property=ActiveState,MainPID').splitlines())
        check(unit + ' active with unchanged MainPID', unit in before and fields.get('ActiveState') == 'active' and int(fields.get('MainPID', '0')) == before[unit] and before[unit] > 0)
except (OSError, ValueError, IndexError, subprocess.CalledProcessError):
    check('probe commands completed', False)
sys.exit(1 if failed else 0)
`;
