import { fsyncSync } from "node:fs";

const WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

/**
 * Synchronize an already opened directory descriptor.
 *
 * Node cannot durably synchronize directory metadata on every Windows
 * filesystem. Only the explicit unsupported-operation errors from that one
 * fsync call are tolerated there. Opening, identity validation, file fsync,
 * and every other I/O error remain authoritative in the owning publisher.
 */
export function fsyncDirectoryDescriptor(
  descriptor,
  fsync = fsyncSync,
  platform = process.platform,
) {
  try {
    fsync(descriptor);
    return true;
  } catch (error) {
    if (
      platform === "win32" &&
      typeof error === "object" &&
      error !== null &&
      WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error.code)
    ) {
      return false;
    }
    throw error;
  }
}
