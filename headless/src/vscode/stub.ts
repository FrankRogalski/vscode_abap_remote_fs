/**
 * Fallbacks for VS Code API surface the headless runtime does not implement.
 *
 * A stub can be called, constructed, awaited (resolves to itself is avoided: `then` is undefined),
 * iterated (empty) and disposed. This keeps UI-only code paths (tree views, status bar items,
 * decorations, webviews...) from crashing while the tools that matter run for real.
 */
import { log } from "../log"

const reported = new Set<string>()
const report = (path: string) => {
  if (reported.has(path)) return
  reported.add(path)
  log.debug(`vscode stub used: ${path}`)
}

const noop = () => undefined

export function stubValue(path: string): any {
  const target = function () {} as any
  return new Proxy(target, {
    get(t, key) {
      if (key === "then") return undefined
      if (key === Symbol.iterator) return function* () {}
      if (key === Symbol.asyncIterator) return async function* () {}
      if (key === Symbol.toPrimitive) return () => `[vscode stub ${path}]`
      if (key === "toString" || key === "toJSON") return () => `[vscode stub ${path}]`
      if (key === "dispose") return noop
      if (key === "length") return 0
      if (typeof key === "symbol") return undefined
      if (key in t && key !== "name" && key !== "prototype") return t[key]
      if (!(key in t)) t[key] = stubValue(`${path}.${key}`)
      return t[key]
    },
    apply() {
      report(path)
      return stubValue(`${path}()`)
    },
    construct() {
      report(`new ${path}`)
      return stubValue(`new ${path}`)
    }
  })
}

export function stubFunction(path: string) {
  return (..._args: unknown[]) => {
    report(path)
    return stubValue(`${path}()`)
  }
}

/** A real class (so `extends` and `instanceof` work) that keeps whatever is assigned to it */
export function stubClass(name: string): any {
  const holder = {
    [name]: class {
      constructor(...args: unknown[]) {
        ;(this as any).__args = args
        report(`new ${name}`)
      }
      dispose() {}
    }
  }
  return holder[name]
}

/** Namespace object: implemented members first, a stub for everything else */
export function stubNamespace(name: string, impl: Record<string, any>, _members: string[]): any {
  const cache: Record<string, any> = {}
  return new Proxy(impl, {
    get(t, key) {
      if (key in t) return t[key as any]
      if (typeof key === "symbol" || key === "then") return undefined
      if (key.startsWith("onDid") || key.startsWith("onWill")) {
        // events: calling them registers nothing and returns a disposable
        return (cache[key] ??= () => ({ dispose: noop }))
      }
      return (cache[key] ??= stubValue(`${name}.${key}`))
    }
  })
}
