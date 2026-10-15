export const validatePurgePath = (path: string, root: string): boolean =>
  path.startsWith(`${root}/`) &&
  path !== root &&
  !path.split("/").some((part) => part === "." || part === "..");

export const purgeScript = String.raw`
import os, shutil, sys
root, target = sys.argv[1:3]
root, target = os.path.abspath(root), os.path.abspath(target)
if target == root or os.path.commonpath([root, target]) != root:
    raise RuntimeError('purge outside declared root')
if os.path.realpath(root) != root or os.path.realpath(target) != target:
    raise RuntimeError('purge refuses symlink roots')
if not shutil.rmtree.avoids_symlink_attacks:
    raise RuntimeError('fd-safe deletion unavailable')
for directory, dirs, files in os.walk(target, followlinks=False):
    if any(os.path.islink(os.path.join(directory, item)) for item in dirs + files):
        raise RuntimeError('purge refuses symlinks')
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    shutil.rmtree(os.path.relpath(target, root), dir_fd=fd)
finally:
    os.close(fd)
`;
