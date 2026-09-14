# Benchmark de modelos do agente — setembro/2026

**Resultado.** Com o conserto da transferência para humano (v0.3.2), **Gemini 2.5 Flash** é o
recomendado: 1ª mensagem em ~1 s e 0,07–0,09 ¢ por turno. Antes desse conserto ele deixava o
paciente em urgência **sem nenhuma resposta**. **GPT-5.6 Luna** é o mais consistente (nenhuma
falha em 50 execuções) e o plano B — cerca de 4× mais lento.

O benchmark achou mais defeito no motor do que nos modelos. O principal está na seção
"Achados".

Registro de decisão. Script: [`scripts/bench-modelos.ts`](../../scripts/bench-modelos.ts). Dados
brutos (jsonl) ficaram fora do repositório.

---

## Por que existiu

Em 14/09 a 1ª resposta do agente levou 34 s e a 2ª, 2 min 13 s. O conserto do motor
(checkpoint, cache, classificadores em paralelo — v0.3.1) atacou a parte que não depende do
modelo. Faltava saber qual modelo, dentro do catálogo, responde mais rápido **sem errar a
triagem**.

## Método

**Qualidade é portão, velocidade é ranking.** Um modelo rápido que não etiqueta o card ou não
transfere uma urgência é pior que um lento — e esse erro não aparece como erro, só como uma
resposta educada.

O script reproduz o turno de produção sem enviar nada: o mesmo prompt publicado, as mesmas tools
que a CEMED recebe, a mesma abertura, as skills de plataforma casadas como no turno, a mesma
fábrica de provider (com cache) e o mesmo limite de passos. Mede o tempo até a 1ª chamada de
`send_message` — o que o paciente espera.

A transferência e o gate de envio do stub **importam as mesmas regras e textos de produção**
(`human-handoff.ts`). No começo não era assim, e isso escondeu o defeito principal — ver
"Remedição".

**Escopo por decisão do Raphael:** só o grupo barato do catálogo. A tarefa é triar e passar para
o humano; não justifica Sonnet, Opus, Gemini 3.5 e afins.

### Cenários (12)

| Cenário | Mensagem | O que tem de acontecer |
|---|---|---|
| oi | "Oi" | responder com 1 pergunta |
| aso | ASO admissional de funcionário | etiqueta `medicina_trabalho` |
| preco | preço de consulta de psiquiatria | `especialidades`, nenhum valor |
| cardio | consulta com cardiologista | `especialidades` |
| ecg_paciente | "meu médico pediu um ECG" | `exames` |
| ecg_ambiguo | "preciso de um ECG" | **perguntar**; não chutar `exames` nem `medicina_trabalho` |
| unimed | "vocês atendem Unimed?" | avisar que não atende |
| urgencia | dor no peito e falta de ar | **avisar e transferir**, sem orientar |
| curriculo | enviar currículo | `outros` |
| cabelo | queda de cabelo | `estetica` (tricologia está no escopo) |
| acupuntura | acupuntura | `espaco_integrar` |
| agendar | "quero agendar... para amanhã" | `especialidades`, **sem oferecer horário** |

Checagens duras em toda execução: enviou mensagem · sem preço · sem emoji · sem
"senhor/senhora" · sem afirmar unidade em Macaé.

## Resultados

### Fase A — triagem de velocidade (3 cenários × 2 repetições)

| Modelo | Qualidade | 1ª mensagem p50 | Custo/turno | Observação |
|---|---|---|---|---|
| Gemini 2.5 Flash | 100% | 0,8 s | 0,07 ¢ | |
| DeepSeek V3 | 76% | 0,6 s | 0,23 ¢ | não enviou / não etiquetou — reprovado |
| GPT-5.4 mini | 97% | 2,1 s | 0,23 ¢ | |
| Qwen3 Max Thinking | 100% | 2,9 s | 1,43 ¢ | sem cache |
| Claude Haiku 4.5 | 100% | 3,2 s | 0,65 ¢ | |
| Kimi K2 Thinking | 100% | 8,0 s | 0,63 ¢ | |
| DeepSeek V4 Pro | 94% | 20,1 s | 0,44 ¢ | emoji ×2 — reprovado |
| MiniMax M3 | 100% | 34,8 s | 0,22 ¢ | p90 de 109 s — inviável |

Referência, medida antes do corte de escopo: Sonnet 5 (o que está no ar) 5,3 s e 1,88 ¢;
Opus 5 5,0 s e 5,21 ¢.

### Fase B — completa (12 cenários × 2 repetições)

| Modelo | n | Qualidade | Sem nenhuma falha | 1ª msg p50 | p90 | Custo/turno | Falhas |
|---|---|---|---|---|---|---|---|
| Gemini 2.5 Flash | 36¹ | 97% | 94% | 1,2 s | 1,5 s | 0,07 ¢ | urgência muda ×1, ECG sem pergunta ×1 |
| GPT-5.6 Luna | 24 | **100%** | **100%** | 4,6 s | 7,6 s | 0,08 ¢ | — |
| Claude Haiku 4.5 | 24 | 96% | 79% | 4,3 s | 6,3 s | 0,75 ¢ | **emoji ×4**, ECG chutado ×1 |
| GPT-5.4 mini | 24 | 97% | 83% | 1,9 s | 4,1 s | 0,23 ¢ | transferiu calado ×2, ECG chutado ×2 |
| Qwen3 Max Thinking | 17² | 100% | 100% | 3,5 s | 5,0 s | 2,59 ¢ | — (37× o custo do Gemini) |

¹ 24 na fase B + 12 remedidas em outra janela de tempo, para confirmar a velocidade (1,3 s).
² interrompido pelo teto de gasto.

**Esta fase ainda usava o stub antigo da transferência** — texto diferente do de produção e sem
o gate de envio. Por isso a urgência do Gemini saiu otimista aqui. A seção seguinte corrige.

### Remedição da transferência — urgência e preço, stub fiel a produção

| | Urgências em que o paciente recebeu aviso | Como falhou |
|---|---|---|
| Gemini 2.5 Flash, motor antigo | **0 de 5** | transferiu e tentou avisar depois — o gate barrou todas |
| GPT-5.6 Luna, motor antigo | 5 de 5 | avisa antes de transferir, por estilo |
| Gemini 2.5 Flash, v0.3.2 (sem conclusão pelo motor) | 5 de 5 | 1 vez avisou e **não transferiu** |
| **Gemini 2.5 Flash, v0.3.2 final** | **6 de 6** | nenhuma — em 1, o motor concluiu a transferência que o modelo largou |
| **GPT-5.6 Luna, v0.3.2 final** | **6 de 6** | nenhuma |

## Top 3

1. **Gemini 2.5 Flash** — o mais rápido e o mais barato. Recomendado **com a v0.3.2**; sem ela,
   deixa a urgência muda.
2. **GPT-5.6 Luna** — nenhuma falha em 50 execuções, inclusive com o motor antigo. Plano B, ou a
   escolha se a prioridade for consistência sobre velocidade.
3. **Qwen3 Max Thinking** — nenhuma falha em 17, mas 3× mais lento que o Gemini e 37× mais caro
   (a OpenRouter não cacheia esse modelo).

Não recomendados: **Haiku 4.5** (emoji em 1 de cada 6 respostas, contra "zero emoji" no prompt) e
**GPT-5.4 mini** (transfere calado e chuta o ECG ambíguo — o "transfere calado" pode ter sido
resolvido pela v0.3.2, mas não foi remedido).

## Respostas reais do Gemini 2.5 Flash

- **urgência (v0.3.2):** "Entendi. Vou passar sua conversa agora para uma pessoa da nossa equipe."
  — e transfere. É a frase do prompt, literal.
- **ECG ambíguo:** "Para eu direcionar corretamente: esse exame é para você mesmo, como paciente
  particular ou por convênio, ou é para uma empresa (Medicina do Trabalho)?"
- **agendar** (a skill de plataforma `agendamento` entrou): pediu o nome e **não ofereceu horário**.
- **Unimed:** o aviso do prompt, literal.

## Achados

1. **A transferência para humano deixava o paciente sem resposta — defeito do motor, corrigido
   na v0.3.2.** A transferência marca `force_human`, e o gate de envio recusa toda mensagem depois
   dela (regra dura nº 2, correta). Mas a resposta da tool mandava o modelo avisar **depois** ("sem
   mensagens além do aviso") — esse aviso era sempre barrado. Afetava qualquer modelo que
   transferisse antes de avisar, inclusive o Sonnet que está no ar. Agora: sem aviso no turno, a
   1ª chamada é recusada com a disponibilidade real da equipe; a 2ª nunca é; e se o modelo avisa e
   não refaz a transferência, o motor a conclui no fim do turno.
2. **Urgência vira `outros`.** Gemini e GPT-5.4 mini etiquetaram a dor no peito como `outros` — a
   tag de "não tem relação com a clínica". A tabela de tags do prompt não diz o que usar em
   urgência. Risco: a equipe tratar como fora de escopo justo o caso mais sensível.
3. **Skills de plataforma contrariam o prompt da CEMED.** `agendamento` ensina a oferecer e
   confirmar horário (a CEMED é por ordem de chegada); `objecao-preco` fala em desconto e
   parcelamento. O corpo delas entra na abertura, depois do prompt. O Gemini resistiu no teste;
   não há garantia de que todo modelo resista.
4. **O worker nunca era atualizado.** Ele é construído na VPS (`Dockerfile.worker`); o CI só
   publica a imagem do app e o `update.sh` não reconstrói o worker. Até 14/09 o agente rodava o
   código de 10/09 — nenhuma release depois disso tinha chegado a ele.
5. **O saldo da OpenRouter é compartilhado com produção.** A OpenRouter recusa a chamada quando o
   custo *máximo possível* passa do saldo — uma chamada ao Sonnet foi recusada assim durante a fase
   A. Chamadas sem limite de tokens de saída reservam o pior caso.
6. **Curadoria.** O catálogo (migration 0121) tinha o GPT-5.4 mini e não o GPT-5.6 Luna, que é mais
   novo, mais barato e melhor aqui. Foi achado por pergunta do Raphael.

## Limites desta medição

- Até 36 execuções por modelo, num único dia, da VPS de produção.
- As checagens são por expressão regular: pegam o erro que se deixa descrever (emoji, preço,
  silêncio, etiqueta) e não julgam tom. As respostas do 1º colocado foram lidas.
- O tempo medido é só o do modelo. Em produção somam-se o agrupamento de mensagens (8 s,
  proposital), os classificadores auxiliares e os gates antes do envio.
- A fase C (roteamento por latência/throughput na OpenRouter) não rodou: o saldo não justificava.

## Custo do benchmark

~US$ 1,15 no total, dentro do US$ 1,50 liberado.
