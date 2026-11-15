# 0017 — Integração com a plataforma Gestão Perfeita (eventos + OIDC, atrás de flag)

- **Data**: 2026-11-15
- **Status**: aceita
- **Validade**: `até o cutover da Fase 4` (Epic gestaoperfeita-platform#1) — revisar quando o login local for desligado
- **ADR ID**: `ADR-0017`
- **Task relacionada**: `TASK-0044`

## Contexto

A Gestão Perfeita passa a ser a fonte da verdade de empresas, direitos de uso (entitlements) e acesso por pessoa (grants). A Agenda continua dona de barbearias, agenda, comandas e financeiro. O contrato v1 está em `gestaoperfeita-platform/docs/integrations/`. A Agenda hoje é 1 usuário = 1 tenant, IDs serial, e produção e preview **compartilham o mesmo banco** (ADR-0016).

## Decisão

1. **Tudo atrás de `GP_PLATFORM_ENABLED`** (padrão desligado). Com a flag desligada a rota de eventos responde 404, o botão OIDC não aparece e o gate de login não roda.
2. **Tabelas aditivas**: `platform_tenant_mappings` (org UUID ↔ tenant), `platform_user_mappings` (usuário central `sub` ↔ usuário local), `platform_processed_events` (idempotência) e a coluna `users.disabled_at`. Nada é removido nem renomeado.
3. **Eventos** (`POST /api/platform/events`): HMAC-SHA256 `t=<unix>,v1=<hex>` com janela de ±300 s e `timingSafeEqual`; cada `id` é aplicado no máximo uma vez.
   - `entitlement.activated` cria a barbearia (só aí) ou reaproveita o mapeamento.
   - `organization.sync` com `external_tenant_id` **adota** uma barbearia legada sem duplicar e converge status e membros.
   - Status da barbearia = entitlement da Agenda **E** empresa ativos (guardados separadamente: reativar a empresa não reativa uma Agenda suspensa).
   - Grants: usuário mapeado pelo `sub`, nunca só pelo e-mail. Um e-mail que já existe em **outra** barbearia gera **409** e não move dados — limitação do modelo 1 usuário = 1 tenant; um operador resolve.
   - Revogação ou suspensão → `disabled_at` + sessões apagadas; histórico preservado.
4. **Bloqueio efetivo**: `isAccessBlocked` passa a considerar `disabled_at` e `Tenant.status = suspended` (vale para sessão viva e para novo login). **Isso vale mesmo com a flag desligada**: uma barbearia marcada como suspensa deixa de entrar no painel, o que antes não era aplicado (o status só escondia o site público).
5. **Login OIDC**: plugin `genericOAuth` (provider `gestaoperfeita`, discovery do emissor central, PKCE, `disableSignUp`, sem account linking por e-mail). A conta OIDC é pré-vinculada pelo `sub` quando o grant chega. Callback: `{BETTER_AUTH_URL}/api/auth/callback/gestaoperfeita`.
6. **Gate de login**: para usuário vinculado à plataforma, qualquer login (OIDC ou senha) chama `access-check`. Nega se a plataforma negar e **falha fechado** se ela estiver indisponível. Usuário não vinculado segue o caminho legado.

## Alternativas consideradas

- Mover usuários entre tenants quando o e-mail coincide — descartado: mistura dados de barbearias diferentes.
- Vincular conta OIDC por e-mail (account linking) — descartado: permitiria tomar uma conta local só por ter o mesmo e-mail na plataforma.
- Ler o banco da plataforma — proibido pelo contrato.

## Consequências

- Rollback: desligar a flag. As tabelas e a coluna aditivas podem ficar.
- Antes de qualquer `migrate deploy` com esta migration: **aplicar primeiro num banco de homologação separado**, porque produção e preview compartilham o banco (ADR-0016) e o build de produção aplica migrations automaticamente.
- Pessoas em várias empresas só funcionam na Agenda se forem usuários locais diferentes (limitação até existir membership N:N na Agenda).
