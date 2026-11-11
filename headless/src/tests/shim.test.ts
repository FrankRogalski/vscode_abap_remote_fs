import { Position, Range, Uri, commands, lm, workspace, window } from "../vscode/index"
import { TextDocument, runtime } from "../vscode/impl"

describe("vscode shim", () => {
  it("TextDocument maps offsets and lines", () => {
    const doc = new TextDocument(Uri.parse("adt://dev100/a.prog.abap"), "REPORT z.\r\nWRITE 1.\nWRITE 2.")
    expect(doc.languageId).toBe("abap")
    expect(doc.lineCount).toBe(3)
    expect(doc.lineAt(1).text).toBe("WRITE 1.")
    const p = new Position(1, 6)
    expect(doc.positionAt(doc.offsetAt(p))).toEqual(p)
    expect(doc.getText(new Range(1, 0, 1, 5))).toBe("WRITE")
  })

  it("routes workspace.fs to registered providers", async () => {
    const files = new Map<string, Uint8Array>()
    workspace.registerFileSystemProvider("mem", {
      stat: async () => ({ type: 1 }),
      readDirectory: async () => [],
      createDirectory: async () => undefined,
      readFile: async (u: any) => files.get(u.path)!,
      writeFile: async (u: any, c: Uint8Array) => void files.set(u.path, c),
      delete: async () => undefined,
      rename: async () => undefined
    })
    const uri = Uri.parse("mem:/x.abap")
    await workspace.fs.writeFile(uri, Buffer.from("hello"))
    const doc = await workspace.openTextDocument(uri)
    expect(doc.getText()).toBe("hello")
    doc.setText("bye")
    await doc.save()
    expect(Buffer.from(files.get("/x.abap")!).toString()).toBe("bye")
  })

  it("commands, tools and headless prompts", async () => {
    commands.registerCommand("t.cmd", (a: number) => a + 1)
    expect(await commands.executeCommand("t.cmd", 1)).toBe(2)
    await expect(commands.executeCommand("abapfs.nope")).rejects.toThrow(/not available/)
    expect(await window.showQuickPick(["a"])).toBeUndefined()

    const seen: unknown[] = []
    runtime.beforeToolInvoke = async (_n, input) => void seen.push(input)
    const tool: any = { invoke: async (o: any, _t?: unknown) => o.input.v * 2 }
    lm.registerTool("t_tool", tool)
    expect(await tool.invoke({ input: { v: 21 } }, undefined)).toBe(42)
    expect(seen).toEqual([{ v: 21 }])
    runtime.beforeToolInvoke = undefined
  })

  it("stubs unknown API without throwing", () => {
    const item = window.createTreeView("x", {})
    expect(() => item.dispose()).not.toThrow()
    const d = workspace.onDidChangeNotebookDocument(() => undefined)
    expect(() => d.dispose()).not.toThrow()
  })
})
