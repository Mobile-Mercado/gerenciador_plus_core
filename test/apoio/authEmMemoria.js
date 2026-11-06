// Auth em memoria para os testes do cadastro e do Admin: so o que eles usam do firebase-admin.
export class AuthEmMemoria {
  constructor(contas = []) {
    this.contas = new Map(contas.map((conta) => [conta.uid, { customClaims: {}, emailVerified: false, disabled: false, ...conta }]));
    this.proximo = 0;
    this.apagadas = [];
  }

  erro(code) {
    return Object.assign(new Error(code), { code });
  }

  async getUser(uid) {
    const conta = this.contas.get(uid);
    if (!conta) throw this.erro('auth/user-not-found');
    return structuredClone(conta);
  }

  async getUserByEmail(email) {
    const conta = [...this.contas.values()].find((item) => item.email === email);
    if (!conta) throw this.erro('auth/user-not-found');
    return structuredClone(conta);
  }

  async createUser(dados) {
    if ([...this.contas.values()].some((item) => item.email === dados.email)) throw this.erro('auth/email-already-exists');
    this.proximo += 1;
    const conta = { uid: `uid-novo-${this.proximo}`, customClaims: {}, ...dados };
    delete conta.password;
    this.contas.set(conta.uid, conta);
    return structuredClone(conta);
  }

  async deleteUser(uid) {
    this.apagadas.push(uid);
    this.contas.delete(uid);
  }

  async setCustomUserClaims(uid, claims) {
    const conta = this.contas.get(uid);
    if (!conta) throw this.erro('auth/user-not-found');
    conta.customClaims = structuredClone(claims || {});
  }

  confirmarEmail(uid) {
    this.contas.get(uid).emailVerified = true;
  }
}
