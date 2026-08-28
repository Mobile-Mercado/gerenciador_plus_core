const test = require("node:test");
const assert = require("node:assert/strict");
const {
    buildDeployArgs,
    publishableFunctionNames,
    resolveProjectName,
} = require("./deploy");

test("nomeia cada função exportada como alvo do deploy", () => {
    const args = buildDeployArgs(["findProducts", "aplicarCupom"], []);
    assert.deepEqual(args, [
        "deploy",
        "--only",
        "functions:findProducts,functions:aplicarCupom",
    ]);
});

test("repassa argumentos extras depois do filtro", () => {
    const args = buildDeployArgs(["findProducts"], ["--project", "meu-projeto"]);
    assert.deepEqual(args, [
        "deploy",
        "--only",
        "functions:findProducts",
        "--project",
        "meu-projeto",
    ]);
});

test("recusa um --only vindo de quem chamou, que anularia a proteção", () => {
    assert.throws(
        () => buildDeployArgs(["findProducts"], ["--only", "functions"]),
        /--only/,
    );
});

test("recusa deploy quando nada foi exportado", () => {
    assert.throws(() => buildDeployArgs([], []), /Nenhuma função/);
});

test("inclui export de função simples e ignora o default do módulo", () => {
    const names = publishableFunctionNames({
        findProducts: () => undefined,
        DEFAULT_REGION: "us-central1",
        default: () => undefined,
    });
    assert.deepEqual(names, ["findProducts"]);
});

test("expande export agrupado em nome pai-filho por função", () => {
    const names = publishableFunctionNames({
        produtosModule: {
            onProductCreate: () => undefined,
            onProductUpdate: () => undefined,
            onProductDelete: () => undefined,
        },
    });
    assert.deepEqual(names, [
        "produtosModule-onProductCreate",
        "produtosModule-onProductUpdate",
        "produtosModule-onProductDelete",
    ]);
});

test("ignora export que não é função nem objeto agrupável", () => {
    const names = publishableFunctionNames({
        findProducts: () => undefined,
        REGIAO_PADRAO: "us-central1",
        habilitado: true,
        contagem: 42,
    });
    assert.deepEqual(names, ["findProducts"]);
});

test("ignora propriedades não-função dentro de um export agrupado", () => {
    const names = publishableFunctionNames({
        produtosModule: {
            onProductCreate: () => undefined,
            versao: "1.0",
        },
    });
    assert.deepEqual(names, ["produtosModule-onProductCreate"]);
});

test("mostra o projeto pedido no comando", () => {
    assert.equal(
        resolveProjectName(["--project", "meu-projeto"], "padrao"),
        "meu-projeto",
    );
});

test("cai no projeto padrão do .firebaserc quando ninguém pediu outro", () => {
    assert.equal(resolveProjectName([], "appmobileprod-19505"), "appmobileprod-19505");
});

test("mostra o projeto pedido com --project=valor", () => {
    assert.equal(
        resolveProjectName(["--project=meu-projeto"], "padrao"),
        "meu-projeto",
    );
});

test("mostra o projeto pedido com -P valor", () => {
    assert.equal(resolveProjectName(["-P", "meu-projeto"], "padrao"), "meu-projeto");
});

test("mostra o projeto pedido com -P=valor", () => {
    assert.equal(resolveProjectName(["-P=meu-projeto"], "padrao"), "meu-projeto");
});

test("não expande um export que é array", () => {
    const names = publishableFunctionNames({
        rotasAntigas: [() => undefined, () => undefined],
    });
    assert.deepEqual(names, []);
});

test("não expande um export que é instância de classe", () => {
    class ModuloDeProdutos {
        onProductCreate() {}
    }
    const names = publishableFunctionNames({
        produtosModule: new ModuloDeProdutos(),
    });
    assert.deepEqual(names, []);
});

test("ignora export nulo em vez de quebrar", () => {
    const names = publishableFunctionNames({
        findProducts: () => undefined,
        featureDesativada: null,
    });
    assert.deepEqual(names, ["findProducts"]);
});

test("recusa um --only=functions:x vindo de quem chamou", () => {
    assert.throws(
        () => buildDeployArgs(["findProducts"], ["--only=functions:findProducts"]),
        /--only/,
    );
});
