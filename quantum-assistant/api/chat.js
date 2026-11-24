export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Не настроен OPENAI_API_KEY в Vercel. Добавь ключ в Settings → Environment Variables и сделай Redeploy." });
  }
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rawMessages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
    const messages = rawMessages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return res.status(400).json({ error: "Напиши сообщение для ассистента." });
    }
    const markets = Array.isArray(body.markets) ? body.markets.slice(0, 15).map(m => ({
      question: String(m.question || "").slice(0, 300),
      volume24hr: Number(m.volume24hr) || 0,
      liquidity: Number(m.liquidity) || 0,
      outcomes: Array.isArray(m.outcomes) ? m.outcomes.slice(0, 8) : [],
      prices: Array.isArray(m.prices) ? m.prices.slice(0, 8) : [],
      spread: Number.isFinite(Number(m.spread)) ? Number(m.spread) : null,
      oneDayPriceChange: Number.isFinite(Number(m.oneDayPriceChange)) ? Number(m.oneDayPriceChange) : null,
      endDate: String(m.endDate || "").slice(0, 40)
    })) : [];
    const instructions = [
      "Ты Quantum AI Assistant — аналитик рынков Polymarket. Отвечай по-русски, ясно и предметно.",
      "Используй переданный снимок рынков только как текущие данные на момент запроса; не выдумывай отсутствующие котировки, новости, вероятности или результаты.",
      "Различай рыночную цену и собственную оценку вероятности. Не заявляй, что Edge существует, если нет независимой оценки вероятности.",
      "Если считаешь потенциальный Edge, явно укажи формулу: собственная вероятность минус рыночная вероятность, а также допущения и неопределённость.",
      "Учитывай ликвидность, спред, комиссии, риск исполнения и возможность полной потери позиции. Не обещай прибыль и не называй сигнал гарантированным.",
      "Это аналитическая помощь, не финансовая рекомендация. При недостатке данных прямо скажи, что нужно проверить."
    ].join(" ");
    const context = "Текущий снимок рынков Polymarket (JSON; значения предоставлены клиентским приложением):\n" + JSON.stringify(markets);
    const input = [{ role: "user", content: context }, ...messages];
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-5.5", instructions, input, max_output_tokens: 900 })
    });
    const result = await upstream.json();
    if (!upstream.ok) {
      const message = result && result.error && result.error.message ? result.error.message : "OpenAI API request failed";
      return res.status(upstream.status >= 500 ? 502 : 400).json({ error: message.slice(0, 500) });
    }
    const reply = Array.isArray(result.output)
      ? result.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
          .filter(part => part.type === "output_text" && typeof part.text === "string")
          .map(part => part.text).join("\n").trim()
      : "";
    if (!reply) return res.status(502).json({ error: "OpenAI вернул пустой ответ." });
    return res.status(200).json({ reply });
  } catch (error) {
    return res.status(500).json({ error: "Внутренняя ошибка сервера. Попробуй ещё раз." });
  }
}
