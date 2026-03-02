export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    try {
      const update = await request.json();

      if (update.callback_query) {
        await handleCallback(update.callback_query, env);
        return new Response("OK");
      }

      const msg = update.message || update.edited_message;
      if (!msg || !msg.chat) return new Response("OK");

      const chatId = msg.chat.id;
      const text = msg.text || msg.caption || "";

      if (text.startsWith("/")) {
        await handleCommand(text, chatId, env);
        return new Response("OK");
      }

      await processTransaction(msg, chatId, text, env);
      return new Response("OK");

    } catch (err) {
      console.error(err);
      return new Response("OK");
    }
  }
};

async function processTransaction(msg, chatId, text, env) {
  let imageUrl = null;

  if (msg.photo && msg.photo.length > 0) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileRes = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    imageUrl = `https://api.telegram.org/file/bot${env.TG_TOKEN}/${fileData.result.file_path}`;
  }

  if (!text && !imageUrl) return;

  const data = await extractDataLLM(text, imageUrl, env);
  if (!data || !data.amount) return;

  await env.DB.prepare(`
    INSERT INTO transactions (message_id, chat_id, type, amount, category, transaction_date)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+7 hours'))
    ON CONFLICT(message_id) DO UPDATE SET 
      amount=excluded.amount, category=excluded.category, type=excluded.type;
  `).bind(msg.message_id, chatId, data.type, data.amount, data.category).run();

  const balanceRes = await env.DB.prepare(`
    SELECT SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END) as balance 
    FROM transactions WHERE chat_id = ?
  `).bind(chatId).first();

  const balance = balanceRes.balance || 0;
  const actionText = data.type === 'income' ? 'Đã nhận' : 'Đã chi';
  const responseText = `${actionText} ${data.amount} cho ${data.category}\nCòn lại ${balance}`;

  await tgAPI('sendMessage', env.TG_TOKEN, { chat_id: chatId, text: responseText });
}

async function handleCommand(text, chatId, env) {
  const cmd = text.split(" ")[0].toLowerCase();
  let query = "";
  
  if (cmd === "/day") query = "date(transaction_date) = date('now', '+7 hours')";
  else if (cmd === "/week") query = "strftime('%W', transaction_date) = strftime('%W', 'now', '+7 hours')";
  else if (cmd === "/month") query = "strftime('%Y-%m', transaction_date) = strftime('%Y-%m', 'now', '+7 hours')";
  else if (cmd === "/year") query = "strftime('%Y', transaction_date) = strftime('%Y', 'now', '+7 hours')";
  else if (cmd === "/dashboard") {
    await sendDashboardHome(chatId, env);
    return;
  } else return;

  const res = await env.DB.prepare(`
    SELECT SUM(amount) as total FROM transactions 
    WHERE chat_id = ? AND type = 'expense' AND ${query}
  `).bind(chatId).first();

  await tgAPI('sendMessage', env.TG_TOKEN, { 
    chat_id: chatId, 
    text: `Total spent (${cmd}): ${res.total || 0}` 
  });
}

async function handleCallback(cb, env) {
  const data = cb.data;
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;

  if (data === "view_home") {
    await sendDashboardHome(chatId, env, msgId);
  } else if (data.startsWith("view_year_")) {
    const year = data.split("_")[2];
    const kb = {
      inline_keyboard: [
        [{text: "01", callback_data: `view_month_${year}_01`}, {text: "02", callback_data: `view_month_${year}_02`}, {text: "03", callback_data: `view_month_${year}_03`}],
        [{text: "04", callback_data: `view_month_${year}_04`}, {text: "05", callback_data: `view_month_${year}_05`}, {text: "06", callback_data: `view_month_${year}_06`}],
        [{text: "07", callback_data: `view_month_${year}_07`}, {text: "08", callback_data: `view_month_${year}_08`}, {text: "09", callback_data: `view_month_${year}_09`}],
        [{text: "10", callback_data: `view_month_${year}_10`}, {text: "11", callback_data: `view_month_${year}_11`}, {text: "12", callback_data: `view_month_${year}_12`}],
        [{text: `📊 Total ${year}`, callback_data: `total_year_${year}`}],
        [{text: "⬅️ Back", callback_data: "view_home"}]
      ]
    };
    await tgAPI('editMessageText', env.TG_TOKEN, { chat_id: chatId, message_id: msgId, text: `${year} Dashboard:`, reply_markup: JSON.stringify(kb) });
  } else if (data.startsWith("total_year_")) {
    const year = data.split("_")[2];
    const res = await env.DB.prepare(`SELECT SUM(amount) as t FROM transactions WHERE chat_id = ? AND type = 'expense' AND strftime('%Y', transaction_date) = ?`).bind(chatId, year).first();
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, { callback_query_id: cb.id, text: `Spent in ${year}: ${res.t || 0}`, show_alert: true });
  } else if (data === "total_all") {
    const res = await env.DB.prepare(`SELECT SUM(amount) as t FROM transactions WHERE chat_id = ? AND type = 'expense'`).bind(chatId).first();
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, { callback_query_id: cb.id, text: `All-Time Spent: ${res.t || 0}`, show_alert: true });
  }
}

async function sendDashboardHome(chatId, env, msgId = null) {
  const { results } = await env.DB.prepare(`
    SELECT DISTINCT strftime('%Y', transaction_date) as year 
    FROM transactions WHERE chat_id = ? ORDER BY year DESC LIMIT 5
  `).bind(chatId).all();

  const buttons = results.map(r => ({ text: r.year, callback_data: `view_year_${r.year}` }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  keyboard.push([{ text: "📊 All-Time Total", callback_data: "total_all" }]);

  const payload = { chat_id: chatId, text: "Select a year:", reply_markup: JSON.stringify({ inline_keyboard: keyboard }) };
  
  if (msgId) {
    payload.message_id = msgId;
    await tgAPI('editMessageText', env.TG_TOKEN, payload);
  } else {
    await tgAPI('sendMessage', env.TG_TOKEN, payload);
  }
}

async function extractDataLLM(text, imageUrl, env) {
  const prompt = `Extract transaction data into strict JSON: {"amount": float, "type": "income" or "expense", "category": "string"}. Use '+' prefix in text or obvious incoming funds in image for income. Fallback category: "misc".`;
  
  const contents = [{ parts: [{ text: prompt }] }];
  
  if (imageUrl) {
    const imgRes = await fetch(imageUrl);
    const arrayBuffer = await imgRes.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    contents[0].parts.push({
      inline_data: { mime_type: "image/jpeg", data: base64 }
    });
  }
  
  if (text) contents[0].parts.push({ text: `User Input: ${text}` });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { response_mime_type: "application/json" } })
  });

  const json = await res.json();
  try {
    return JSON.parse(json.candidates[0].content.parts[0].text);
  } catch {
    return null;
  }
}

async function tgAPI(method, token, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
