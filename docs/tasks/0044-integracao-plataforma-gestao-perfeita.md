---
status: em-andamento
modulo: integracao
owner: Durvaldo Gonçalves Marques
criado-em: 2026-11-15
---

# 0044 — Integração com a plataforma Gestão Perfeita

**Task ID**: `TASK-0044`

## Objetivo

Lado Agenda da task Durvaldo/gestaoperfeita-platform#13: receber eventos assinados da plataforma (provisionar ou adotar barbearia, aplicar grants, revogar, suspender), entrar via OIDC no emissor central e respeitar a decisão central de acesso. Tudo atrás de `GP_PLATFORM_ENABLED`, sem mudar o comportamento atual com a flag desligada.

## Dependências

- Contrato v1 da plataforma (gestaoperfeita-platform#11).
- Client OIDC da Agenda cadastrado na plataforma (redirect `{BETTER_AUTH_URL}/api/auth/callback/gestaoperfeita`).

## Critérios de conclusão

- [x] Migration aditiva com mapeamentos, idempotência e `users.disabled_at`.
- [x] `POST /api/platform/events` com assinatura, janela de tempo e idempotência.
- [x] Provisiona só em `entitlement.activated`; adota barbearia legada via `organization.sync` sem duplicar.
- [x] E-mail que já existe em outra barbearia → 409, sem mover dados.
- [x] Revogação desativa o usuário e apaga as sessões, mantendo o histórico; barbearia suspensa é bloqueada.
- [x] Login OIDC (`genericOAuth`) + gate `access-check` que falha fechado.
- [x] Testes (`src/server/__tests__/platform-integration.test.ts`) e suíte existente verdes.
- [ ] Migration aplicada num banco de homologação separado (não no banco compartilhado prod/preview).
- [ ] PoC OIDC ponta a ponta contra a plataforma em homologação.

## Referências

- `docs/decisions/0017-integracao-plataforma-gestao-perfeita.md`
- `docs/decisions/0016-migrations-no-build-de-producao-da-vercel.md`

## Notas de progresso

- 2026-11-15 — Implementação local com Postgres local (bancos `agenda_dev` e `agenda_test`). Nada publicado e nenhuma migration aplicada no Prisma Postgres da Vercel.
