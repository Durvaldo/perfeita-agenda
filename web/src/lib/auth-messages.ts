// User-facing (pt-BR) messages for Better Auth error codes. Texts follow the
// legacy backend/lang/pt_BR/auth.php where an equivalent exists.
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Essas credenciais não conferem com nossos registros.",
  INVALID_EMAIL: "Informe um e-mail válido.",
  INVALID_PASSWORD: "A senha informada está incorreta.",
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "O cadastro público está desativado.",
  TENANT_SUSPENDED: "O acesso desta barbearia está suspenso. Fale com a Gestão Perfeita.",
  PLATFORM_ACCESS_DENIED: "Seu acesso à Agenda não está liberado na Gestão Perfeita. Fale com o gestor da sua empresa.",
  PLATFORM_NOT_LINKED: "Sua conta da Gestão Perfeita ainda não está vinculada a esta Agenda. Fale com o gestor da sua empresa.",
  PLATFORM_UNAVAILABLE: "Não foi possível confirmar seu acesso na Gestão Perfeita. Tente novamente em instantes.",
  ACCOUNT_DISABLED: "Seu acesso está desativado. Fale com o administrador da barbearia.",
};

const TOO_MANY_REQUESTS = "Muitas tentativas de login. Tente novamente em instantes.";
const FALLBACK = "Não foi possível entrar. Tente novamente.";

export function authErrorMessage(error: { code?: string; status?: number } | null | undefined): string {
  if (error?.status === 429) {
    return TOO_MANY_REQUESTS;
  }
  return (error?.code && MESSAGES[error.code]) || FALLBACK;
}

/**
 * Message for an error code sent back by the OIDC callback (?error=...). Better Auth
 * reports a sub with no pre-linked account as signup_disabled/account_not_linked.
 */
export function oauthErrorMessage(code: string): string {
  if (/signup|not_linked|user_not_found|account/i.test(code) && !MESSAGES[code]) return MESSAGES.PLATFORM_NOT_LINKED!;
  return MESSAGES[code] ?? MESSAGES[code.toUpperCase()] ?? FALLBACK;
}
