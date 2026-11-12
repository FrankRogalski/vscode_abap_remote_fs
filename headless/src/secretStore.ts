/**
 * Passwords in the operating system's credential store, one entry per system id:
 *   macOS    login keychain, generic password (service "abapfs-mcp", account <id>)
 *   Windows  Credential Manager, generic credential "abapfs-mcp:<id>"
 *   Linux    Secret Service (GNOME Keyring, KWallet) via secret-tool, service abapfs-mcp account <id>
 *
 * `storePassword` lets the OS tool prompt for the password itself, so it never passes through
 * this process or its command line.
 */
import { execFileSync, spawnSync } from "node:child_process"

export const SERVICE = "abapfs-mcp"

// Credential Manager has no CLI that returns a password; CredRead/CredWrite via PowerShell does.
const WIN_CRED = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AbapfsCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string secret) {
    var bytes = System.Text.Encoding.Unicode.GetBytes(secret);
    var c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = bytes.Length;
    c.CredentialBlob = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
  public static bool Delete(string target) { return CredDelete(target, 1, 0); }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
`

const WIN_READ = `${WIN_CRED}
$v = [AbapfsCred]::Read($env:ABAPFS_CRED_TARGET)
if ($null -eq $v) { exit 3 }
[Console]::Out.Write($v)
`

// ABAPFS_CRED_SECRET is only used by tests; interactive use prompts with masked input
const WIN_WRITE = `${WIN_CRED}
if ($env:ABAPFS_CRED_SECRET) { $plain = $env:ABAPFS_CRED_SECRET } else {
  $a = Read-Host -AsSecureString "Password for $env:ABAPFS_CRED_ACCOUNT"
  $b = Read-Host -AsSecureString "Repeat password"
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
  $again = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
  if ($plain -ne $again) { Write-Error 'Passwords do not match'; exit 4 }
}
[AbapfsCred]::Write($env:ABAPFS_CRED_TARGET, $env:ABAPFS_CRED_ACCOUNT, $plain)
`

const WIN_DELETE = `${WIN_CRED}
if (-not [AbapfsCred]::Delete($env:ABAPFS_CRED_TARGET)) { exit 3 }
`

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64")
const powershell = (script: string, interactive = false) =>
  [
    "powershell.exe",
    [
      "-NoProfile",
      ...(interactive ? [] : ["-NonInteractive"]),
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded(script)
    ]
  ] as const

export const windowsTarget = (id: string) => `${SERVICE}:${id}`

export class SecretStoreError extends Error {}

const describe = () =>
  process.platform === "darwin"
    ? "macOS keychain"
    : process.platform === "win32"
      ? "Windows Credential Manager"
      : "Secret Service (secret-tool)"

/** Password stored for a system id, or undefined when there is none */
export function readStoredPassword(id: string): string | undefined {
  const run = (cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv) => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
        windowsHide: true
      })
    } catch (e: any) {
      if (e.code === "ENOENT")
        throw new SecretStoreError(`${describe()} is not available: ${cmd} not found`)
      return undefined // not found (security: 44, secret-tool: 1, powershell: 3)
    }
  }
  let out: string | undefined
  if (process.platform === "darwin")
    out = run("security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"])?.replace(
      /\n$/,
      ""
    )
  else if (process.platform === "win32") {
    const [cmd, args] = powershell(WIN_READ)
    out = run(cmd, args, { ABAPFS_CRED_TARGET: windowsTarget(id) })
  } else out = run("secret-tool", ["lookup", "service", SERVICE, "account", id])?.replace(/\n$/, "")
  return out ? out : undefined
}

/** Prompt for a password and store it (replacing an existing one). Interactive. */
export function storePassword(id: string, env: NodeJS.ProcessEnv = {}) {
  let cmd: string, args: readonly string[]
  if (process.platform === "darwin")
    [cmd, args] = ["security", ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w"]]
  else if (process.platform === "win32")
    [cmd, args] = powershell(WIN_WRITE, !env.ABAPFS_CRED_SECRET)
  else
    [cmd, args] = [
      "secret-tool",
      ["store", `--label=ABAP FS ${id}`, "service", SERVICE, "account", id]
    ]
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ABAPFS_CRED_TARGET: windowsTarget(id),
      ABAPFS_CRED_ACCOUNT: id,
      ...env
    }
  })
  if (r.error) throw new SecretStoreError(`${describe()}: ${r.error.message}`)
  if (r.status !== 0) throw new SecretStoreError(`${describe()}: storing the password failed`)
}

/** Remove a stored password. Returns false when there was none. */
export function deleteStoredPassword(id: string): boolean {
  let cmd: string, args: readonly string[]
  if (process.platform === "darwin")
    [cmd, args] = ["security", ["delete-generic-password", "-s", SERVICE, "-a", id]]
  else if (process.platform === "win32") [cmd, args] = powershell(WIN_DELETE)
  else [cmd, args] = ["secret-tool", ["clear", "service", SERVICE, "account", id]]
  const r = spawnSync(cmd, args, {
    stdio: "ignore",
    env: { ...process.env, ABAPFS_CRED_TARGET: windowsTarget(id) },
    windowsHide: true
  })
  if (r.error) throw new SecretStoreError(`${describe()}: ${r.error.message}`)
  return r.status === 0
}

export const secretStoreName = describe
