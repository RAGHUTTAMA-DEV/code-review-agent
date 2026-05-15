import Parser from "tree-sitter";
// @ts-ignore
import ts from "tree-sitter-typescript";
// @ts-ignore
import js from "tree-sitter-javascript";

export function getEnclosingFunctions(content: string, filePath: string, changedLineNumbers: number[]) {
    const parser = new Parser();
    
    if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
        parser.setLanguage(ts.typescript as any);
    } else if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) {
        parser.setLanguage(js as any);
    } else {
        return null;
    }

    const tree = parser.parse(content);
    
    const functions: { name: string; content: string; startLine: number; endLine: number }[] = [];
    
    function walk(node: Parser.SyntaxNode) {
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
    
    return results;
}
