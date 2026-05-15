import path from "path";

// web-tree-sitter is an ESM-first package; we require the CJS build directly
// and use type annotations from the .d.cts to keep things working with commonjs.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TreeSitter = require("web-tree-sitter") as typeof import("web-tree-sitter");

type Parser = InstanceType<typeof TreeSitter.Parser>;
type Language = InstanceType<typeof TreeSitter.Language>;
type SyntaxNode = ReturnType<Parser["parse"]> extends { rootNode: infer N } ? N : never;

// ─── Singleton: lazily init parser + languages ────────────────────────────────
let initPromise: Promise<void> | null = null;
let tsLang: Language;
let jsLang: Language;

async function ensureInit() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        await TreeSitter.Parser.init();

        // tree-sitter-wasms ships prebuilt .wasm grammars in its "out" folder
        const wasmsDir = path.dirname(require.resolve("tree-sitter-wasms/package.json"));

        tsLang = await TreeSitter.Language.load(
            path.join(wasmsDir, "out", "tree-sitter-typescript.wasm")
        );
        jsLang = await TreeSitter.Language.load(
            path.join(wasmsDir, "out", "tree-sitter-javascript.wasm")
        );
    })();
    return initPromise;
}

export async function getEnclosingFunctions(content: string, filePath: string, changedLineNumbers: number[]) {
    await ensureInit();

    const parser = new TreeSitter.Parser();

    if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
        parser.setLanguage(tsLang);
    } else if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
        parser.setLanguage(jsLang);
    } else {
        return null;
    }

    const tree = parser.parse(content);
    if (!tree) return null;

    const functions: { name: string; content: string; startLine: number; endLine: number }[] = [];

    function walk(node: any) {
        const isFunction = ["function_declaration", "method_definition", "arrow_function"].includes(node.type);

        if (isFunction) {
            let name = "anonymous";
            if (node.type === "function_declaration" || node.type === "method_definition") {
                const nameNode = node.childForFieldName("name");
                if (nameNode) name = nameNode.text;
            } else if (node.type === "arrow_function") {
                if (node.parent?.type === "variable_declarator") {
                    const nameNode = node.parent.childForFieldName("name");
                    if (nameNode) name = nameNode.text;
                }
            }

            functions.push({
                name,
                content: node.text,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            });
        }

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) walk(child);
        }
    }

    walk(tree.rootNode);

    const enclosingFunctions = new Set<string>();
    const results = [];

    for (const line of changedLineNumbers) {
        let smallestFunc = null;
        for (const func of functions) {
            if (line >= func.startLine && line <= func.endLine) {
                if (!smallestFunc || (func.endLine - func.startLine < smallestFunc.endLine - smallestFunc.startLine)) {
                    smallestFunc = func;
                }
            }
        }
        if (smallestFunc && !enclosingFunctions.has(smallestFunc.name + smallestFunc.startLine)) {
            enclosingFunctions.add(smallestFunc.name + smallestFunc.startLine);
            results.push(smallestFunc);
        }
    }

    tree.delete();
    parser.delete();

    return results;
}
