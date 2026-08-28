const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

function publishableFunctionNames(mod) {
    const names = [];
    for (const [name, value] of Object.entries(mod)) {
        if (name === "default") continue;
        if (typeof value === "function") {
            names.push(name);
        } else if (value !== null && typeof value === "object") {
            for (const [childName, childValue] of Object.entries(value)) {
                if (typeof childValue === "function") {
                    names.push(`${name}-${childName}`);
                }
            }
        }
    }
    return names;
}

function buildDeployArgs(names, extraArgs) {
    if (names.length === 0) {
        throw new Error("Nenhuma função exportada pelo módulo declarado em package.json.");
    }
    const overridesFilter = extraArgs.some((arg) => arg.startsWith("--only"));
    if (overridesFilter) {
        throw new Error(
            "--only é montado por este script e não pode ser sobrescrito.",
        );
    }
    const targets = names.map((name) => `functions:${name}`).join(",");
    return ["deploy", "--only", targets, ...extraArgs];
}

function resolveProjectName(extraArgs, fallback) {
    const flagIndex = extraArgs.indexOf("--project");
    const chosen = flagIndex >= 0 ? extraArgs[flagIndex + 1] : undefined;
    return chosen ?? fallback ?? "não declarado";
}

function defaultProjectFromConfig() {
    try {
        const file = path.join(__dirname, "..", ".firebaserc");
        const config = JSON.parse(readFileSync(file, "utf8"));
        return config?.projects?.default;
    } catch {
        return undefined;
    }
}

function entryPointFromPackageJson() {
    try {
        const file = path.join(__dirname, "package.json");
        const pkg = JSON.parse(readFileSync(file, "utf8"));
        return pkg.main || "index.js";
    } catch {
        return "index.js";
    }
}

function loadDeclaredFunctions() {
    const entry = entryPointFromPackageJson();
    try {
        return require(path.join(__dirname, entry));
    } catch (error) {
        throw new Error(`Não consegui carregar ${entry}: ${error}`);
    }
}

function resolveFirebaseCommand() {
    try {
        const bin = require.resolve("firebase-tools/lib/bin/firebase.js");
        return { command: process.execPath, args: [bin] };
    } catch {
        try {
            execFileSync(process.platform === "win32" ? "where" : "which", ["firebase"], {
                stdio: "ignore",
            });
            return { command: "firebase", args: [] };
        } catch {
            throw new Error(
                "Não encontrei o Firebase CLI: nem firebase-tools no node_modules, nem `firebase` no PATH.",
            );
        }
    }
}

function main() {
    const names = publishableFunctionNames(loadDeclaredFunctions());
    const args = buildDeployArgs(names, process.argv.slice(2));
    const project = resolveProjectName(
        process.argv.slice(2),
        defaultProjectFromConfig(),
    );
    console.log(`Projeto: ${project}`);
    console.log(`Publicando ${names.length} funções declaradas neste repositório:`);
    for (const name of names) console.log(`  ${name}`);
    const { command, args: baseArgs } = resolveFirebaseCommand();
    try {
        execFileSync(command, [...baseArgs, ...args], { stdio: "inherit" });
    } catch (error) {
        const status = typeof error.status === "number" ? error.status : 1;
        process.exit(status);
    }
}

if (require.main === module) main();

module.exports = {
    publishableFunctionNames,
    buildDeployArgs,
    resolveProjectName,
};
