# Pesquisa Semente CRM no OpenReply

Campanha `pesquisa_semente_crm`, separada das automações legadas. Usa o Postgres/Prisma, a fila BullMQ `dm-processing`, Redis, limite por conta, limite do plano, token criptografado e mensagens oficiais da Meta já existentes. Não há scraping, login automatizado, LLM ou novas dependências.

## Operação

Abra `/crm-outreach` pelo menu **Pesquisa CRM** como OWNER ou ADMIN do workspace. Escolha a conta, carregue os posts/reels e marque os desejados. **Importar** apenas lê a API oficial e grava a campanha pausada; não envia mensagens. A campanha reúne os posts selecionados e deduplica pelo ID do autor da Meta. Comentários repetidos são preservados para auditoria.

Registros com DM histórica SENT na mesma conta ficam em `do_not_contact / already_contacted`. Comentários fora de sete dias ficam inelegíveis; nunca são usados em POST para testar uma restrição documentada. `eligible` significa candidato pela idade e histórico, não garantia de que a Meta permitirá o envio. A primeira mensagem também consulta o comentário novamente na Meta e confere autor/data antes do POST.

Selecione explicitamente de 1 a 5 candidatos e use **Enviar piloto selecionado**, confirmando o envio real. O modo `pilot` autoriza apenas os selecionados e suas respostas; não libera os demais. Se houver menos de três candidatos, é possível testar o que existe, mas a campanha completa fica bloqueada. **Revisei o piloto: iniciar campanha completa** exige pelo menos três primeiras DMs piloto confirmadas e nova confirmação explícita. O histórico mostra datas/idades, HTTP de consulta, IDs da mensagem/recipient ou código/subcódigo da recusa real.

Primeira DM: texto fornecido pelo proprietário, sem link. Nenhuma personalização inventada. A segunda DM só é enfileirada depois de uma mensagem real recebida pelo webhook, com timestamp verificável, interesse explícito e janela de 24 horas aberta. Não usa clique de botão, recibo de leitura ou ausência de resposta como consentimento. Perguntas/emoji/respostas ambíguas vão para `manual_review`. OWNER/ADMIN pode conferir o inbox e aprovar interesse; nunca pode aprovar um resultado de envio incerto ou uma janela expirada.

Não há follow-up. Respostas negativas bloqueiam novos envios. Campanha pausada não envia; retomar preserva `pilot` até a aprovação da campanha completa. Remover da fila e não contatar são estados de supressão persistidos, conferidos novamente pelo worker imediatamente antes do POST. Um POST de resultado desconhecido fica em revisão e não é repetido; falhas conhecidas só podem ser reenfileiradas manualmente quando elegíveis. Retries manuais aguardam pelo menos 30 minutos. Qualquer recusa Meta pausa a campanha, para investigação.

Painel: total único, duplicados, candidatos/inelegíveis, primeira DM enviada, respostas, interessados, pesquisa enviada, não interessados, revisão e falhas; filtros e CSV completo protegido. `response_rate = pessoas com resposta verificada / primeiras DMs enviadas`; `survey_send_rate = pesquisas enviadas / primeiras DMs enviadas`. `survey_completed` é confirmação manual após verificar no admin da pesquisa, não inferência por clique. Não há correlação automática confiável entre identidade Instagram e telefone coletado no site nesta versão.

Campanhas antigas seguem existentes. A supressão da automação legada é limitada às pessoas efetivamente selecionadas/enfileiradas pela nova campanha ou com opt-out manual; somente importar candidatos não toma controle da automação antiga. O worker confere novamente envios legados antes da primeira abordagem.

## Configuração

No web e worker:

```env
CRM_OUTREACH_ENABLED=true
CRM_SURVEY_URL=https://www.sistemabritto.com.br/pesquisa-crm
CRM_OUTREACH_BATCH_SIZE=5
CRM_OUTREACH_BATCH_INTERVAL_MINUTES=30
CRM_OUTREACH_DAILY_LIMIT=50
CRM_FOLLOWUP_ENABLED=false
```

Sem `CRM_OUTREACH_ENABLED=true`, os hooks ficam desligados; permite rollout seguro antes da migration. Os limites específicos são reservas atômicas no Redis, compartilhadas entre primeira DM e pesquisa: no máximo cinco tentativas por intervalo de 30 minutos e 50/dia UTC por campanha, além dos limites mais restritivos da conta/plano/API. Não há randomização. Alterações de config são validadas; follow-up não pode ser habilitado neste código.

## Migration e deploy

Migration aditiva `prisma/migrations/20261013180000_crm_outreach/migration.sql`: quatro tabelas, índices, unicidade por pessoa/comentário, FKs e transação explícita. Não altera registros ou schema das campanhas existentes. Backup completo antes de migration, guardado na VPS em `/root/backups/openreply/pre-crm-outreach-20261013.dump`, permissão 600; validado com `pg_restore --list`.

A imagem existente contém web + worker. Depois de CI/build publicar a tag do commit:

```sh
CRM_IMAGE="excarplex/openreply:sha-$(git rev-parse --short HEAD)"
ssh evo-nexus-vps "docker pull $CRM_IMAGE"
# Preserve env/secrets/redes/volumes: atualizar os serviços existentes, não recriar stack.
ssh evo-nexus-vps "docker service update --image $CRM_IMAGE --update-order start-first --update-failure-action rollback openreply_openreply-web"
# Obter o novo container web e executar a migration usando suas credenciais existentes:
ssh evo-nexus-vps 'CRM_WEB=$(docker ps --filter name=openreply_openreply-web --format "{{.ID}}" | head -n 1); docker exec "$CRM_WEB" sh -c "cd /app; npx prisma migrate deploy"'
ssh evo-nexus-vps "docker service update --image $CRM_IMAGE --update-order start-first --update-failure-action rollback openreply_openreply-worker"
# Aplicar as envs acima em ambos via docker service update --env-add.
```

Para rollback do código, `docker service rollback openreply_openreply-web` e `docker service rollback openreply_openreply-worker`; desligue a feature em ambos. Não remova as novas tabelas com respostas/auditoria; migration aditiva continua compatível com a versão anterior.

Ferramenta de importação no container autorizado, sempre sem início automático:

```sh
npx tsx scripts/crm-outreach-admin.ts import sistemabritto 'https://www.instagram.com/reel/DcpcV-kNq9k/' 'https://www.instagram.com/reel/DcRZptzSk5a/'
npx tsx scripts/crm-outreach-admin.ts report sistemabritto
```

## Verificação

```sh
npm run lint
npm run typecheck
npm test
DATABASE_URL=postgresql://postgres:local@127.0.0.1:5432/openreply npm run build
# Somente banco temporário em localhost, com migrations aplicadas:
DATABASE_URL=postgresql://postgres:crm-local-test@127.0.0.1:3121/postgres npx tsx scripts/crm-outreach-db-test.ts
```

Testes incluem respostas positivas/negativas/ambíguas, janelas exatas, proteção de envio pausado/terminal/histórico, resultado incerto, timestamp ausente, reserva de piloto, auth/workspace e bloqueio da campanha completa. Banco real testa migration, unicidade, dez claims concorrentes, recuperação de POST interrompido, pausa, replay de webhook, opt-out e FKs.

Documentação oficial: https://developers.facebook.com/documentation/instagram-platform/private-replies . Uma private reply por comentário dentro de sete dias; mensagens seguintes exigem resposta real e janela de 24 horas. Consulte novamente a API no momento de qualquer envio. A conta já tem webhooks `comments`/`messages`; não são alterados, e nenhum token/senha é solicitado ou exposto por esta funcionalidade.
