// Formulário público de contestação (página /correcoes.html).
// Sem framework: envia para /api/corrections, mostra protocolo e consulta estado.
// Se o registro falhar, o usuário recebe a mensagem real do servidor — nunca uma
// confirmação falsa.
(function () {
  const form = document.getElementById("corrections-form");
  const statusForm = document.getElementById("status-form");
  const statusLine = document.getElementById("form-status");
  const statusResult = document.getElementById("status-result");
  const counter = document.getElementById("message-count");
  const messageField = document.getElementById("message");
  const submitButton = document.getElementById("submit-button");

  const STATUS_LABEL = {
    received: "Recebido",
    in_review: "Em revisão",
    awaiting_info: "Aguardando informação",
    corrected: "Corrigido",
    maintained: "Mantido",
    closed: "Encerrado",
  };

  const ERROR_TEXT = {
    message_too_short: "Descreva o pedido com pelo menos 20 caracteres.",
    message_too_long: "A mensagem passa de 4000 caracteres. Resuma o essencial.",
    bad_check_id: "O ID da checagem tem formato inválido (use letras, números e hífen).",
    bad_evidence_url: "O link da evidência precisa começar com http:// ou https://.",
    rate_limited: "Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente de novo.",
    corrections_unavailable: "O canal está indisponível nesta implantação: o armazenamento durável não está configurado.",
    corrections_write_failed: "Não foi possível registrar o pedido agora. Tente novamente mais tarde.",
    bad_request: "Requisição inválida.",
    not_found: "Protocolo não encontrado.",
  };

  function say(node, text, tone) {
    node.textContent = text;
    node.dataset.tone = tone || "";
  }

  const params = new URLSearchParams(location.search);
  const prefill = params.get("checkId");
  if (prefill) document.getElementById("checkId").value = prefill.slice(0, 80);

  // Link vindo do card compartilhado: mostra se o resultado já foi corrigido.
  const avisoCheck = document.getElementById("check-status");
  if (prefill && avisoCheck) {
    say(avisoCheck, "Consultando o histórico deste resultado…");
    fetch(`/api/corrections?checkId=${encodeURIComponent(prefill)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data) {
          say(avisoCheck, "Não foi possível consultar o histórico deste resultado agora.", "warning");
          return;
        }
        if (data.correctedAt) {
          const quando = new Date(data.correctedAt).toLocaleString("pt-BR");
          say(avisoCheck, `Este resultado tem correção editorial aplicada em ${quando}. A versão vigente é a corrigida.`, "warning");
          return;
        }
        if ((data.corrections ?? []).length > 0) {
          const ultimo = data.corrections[0];
          say(avisoCheck, `Há ${data.corrections.length} contestação(ões) registrada(s); situação mais recente: ${ultimo.statusLabel}. O resultado ainda não foi alterado.`, "warning");
          return;
        }
        say(avisoCheck, "Nenhuma contestação registrada para este resultado até agora.");
      })
      .catch(() => say(avisoCheck, "Falha de rede ao consultar o histórico deste resultado.", "warning"));
  }

  messageField?.addEventListener("input", () => {
    if (counter) counter.textContent = String(messageField.value.length);
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      checkId: String(data.get("checkId") || "").trim(),
      kind: String(data.get("kind") || "correction"),
      message: String(data.get("message") || ""),
      evidenceUrl: String(data.get("evidenceUrl") || "").trim(),
      contact: String(data.get("contact") || "").trim(),
      website: String(data.get("website") || ""),
    };
    if (payload.message.trim().length < 20) {
      say(statusLine, ERROR_TEXT.message_too_short, "error");
      messageField?.focus();
      return;
    }
    submitButton.disabled = true;
    say(statusLine, "Enviando…");
    try {
      const response = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        say(statusLine, ERROR_TEXT[body.error] || body.message || `Não foi possível enviar (HTTP ${response.status}).`, "error");
        return;
      }
      const persisted = body.persisted === false;
      say(
        statusLine,
        `${body.message || "Pedido registrado."} Protocolo: ${body.protocol}.${persisted ? " Atenção: o registro não é durável nesta implantação." : ""}`,
        persisted ? "warning" : "ok",
      );
      const protocolField = document.getElementById("protocol");
      if (protocolField) protocolField.value = body.protocol;
      form.reset();
      if (counter) counter.textContent = "0";
    } catch {
      say(statusLine, "Falha de rede ao enviar o pedido. Tente novamente.", "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  statusForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const protocol = String(new FormData(statusForm).get("protocol") || "").trim();
    if (!protocol) {
      say(statusResult, "Informe o protocolo recebido no envio.", "error");
      return;
    }
    say(statusResult, "Consultando…");
    try {
      const response = await fetch(`/api/corrections?protocol=${encodeURIComponent(protocol)}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        say(statusResult, ERROR_TEXT[body.error] || `Consulta indisponível (HTTP ${response.status}).`, "error");
        return;
      }
      const correction = body.correction ?? {};
      const label = correction.statusLabel || STATUS_LABEL[correction.status] || correction.status;
      say(statusResult, `Protocolo ${correction.protocol}: ${label}. Recebido em ${new Date(correction.at).toLocaleString("pt-BR")}.`, "ok");
    } catch {
      say(statusResult, "Falha de rede na consulta. Tente novamente.", "error");
    }
  });
})();
