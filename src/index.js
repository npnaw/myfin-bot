const formatVND = (amount) => {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    try {
      const update = await request.json();

      if (update.callback_query) {
        await handleCallback(update.callback_query, env);
        return new Response("OK");
      }

      const isEdit = !!update.edited_message;
      const msg = update.message || update.edited_message;
      if (!msg || !msg.chat) return new Response("OK");

      const chatId = msg.chat.id;
      if (chatId.toString() !== env.MY_CHAT_ID) {
        console.log(`Unauthorized access attempt from ${chatId}`);
        return new Response("OK");
      }


      const text = msg.text || msg.caption || "";

      if (text.startsWith("/")) {
        await handleCommand(text, chatId, env);
        return new Response("OK");
      }

      await processTransaction(msg, chatId, text, env, isEdit);
      return new Response("OK");

    } catch (err) {
      console.error(err);
      return new Response("OK");
    }
  }
};

async function processTransaction(msg, chatId, text, env, isEdit = false) {
  if (!text) return;

  const data = parseTransaction(text);
  if (!data) return;

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
  const responseText = `${actionText} ${formatVND(data.amount)} cho ${data.category}\nCòn lại ${formatVND(balance)}`;

  if (isEdit) {
    const existing = await env.DB.prepare(
      `SELECT bot_message_id FROM transactions WHERE message_id = ? AND chat_id = ?`
    ).bind(msg.message_id, chatId).first();

    if (existing?.bot_message_id) {
      await tgAPI('editMessageText', env.TG_TOKEN, {
        chat_id: chatId,
        message_id: existing.bot_message_id,
        text: responseText,
      });
      return;
    }
  }

  const sentRes = await tgAPI('sendMessage', env.TG_TOKEN, {
    chat_id: chatId,
    text: responseText,
    reply_to_message_id: msg.message_id,
  });
  const sentJson = await sentRes.json();
  const botMsgId = sentJson?.result?.message_id;

  if (botMsgId) {
    await env.DB.prepare(
      `UPDATE transactions SET bot_message_id = ? WHERE message_id = ? AND chat_id = ?`
    ).bind(botMsgId, msg.message_id, chatId).run();
  }
}

async function handleCommand(text, chatId, env) {
  const cmd = text.split(" ")[0].toLowerCase();
  
  if (cmd === "/balance") {
    const balanceRes = await env.DB.prepare(`
      SELECT SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END) as balance 
      FROM transactions WHERE chat_id = ?
    `).bind(chatId).first();
    
    await tgAPI('sendMessage', env.TG_TOKEN, { 
      chat_id: chatId, 
      text: `Số dư hiện tại: ${formatVND(balanceRes.balance || 0)}` 
    });
    return;
  }

  let query = "";
  let dateLabel = "";

  const now = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = now.getUTCFullYear();

  if (cmd === "/day") {
    query = "date(transaction_date) = date('now', '+7 hours')";
    dateLabel = `${dd}/${mm}/${yyyy}`;
  } else if (cmd === "/week") {
    query = "strftime('%W', transaction_date) = strftime('%W', 'now', '+7 hours')";
    
    const dayOfWeek = now.getUTCDay();
    const diffToMonday = now.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    
    const startOfWeek = new Date(now.getTime());
    startOfWeek.setUTCDate(diffToMonday);
    
    const endOfWeek = new Date(startOfWeek.getTime());
    endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 6);

    const sDD = String(startOfWeek.getUTCDate()).padStart(2, '0');
    const sMM = String(startOfWeek.getUTCMonth() + 1).padStart(2, '0');
    const sYYYY = startOfWeek.getUTCFullYear();

    const eDD = String(endOfWeek.getUTCDate()).padStart(2, '0');
    const eMM = String(endOfWeek.getUTCMonth() + 1).padStart(2, '0');
    const eYYYY = endOfWeek.getUTCFullYear();

    dateLabel = `${sDD}-${sMM}-${sYYYY} -> ${eDD}-${eMM}-${eYYYY}`;
  } else if (cmd === "/month") {
    query = "strftime('%Y-%m', transaction_date) = strftime('%Y-%m', 'now', '+7 hours')";
    dateLabel = `${mm}/${yyyy}`;
  } else if (cmd === "/year") {
    query = "strftime('%Y', transaction_date) = strftime('%Y', 'now', '+7 hours')";
    dateLabel = `${yyyy}`;
  } else if (cmd === "/dashboard") {
    await sendDashboardHome(chatId, env);
    return;
  } else return;

  const res = await env.DB.prepare(`
    SELECT SUM(amount) as total FROM transactions 
    WHERE chat_id = ? AND type = 'expense' AND ${query}
  `).bind(chatId).first();

  await tgAPI('sendMessage', env.TG_TOKEN, { 
    chat_id: chatId, 
    text: `Tổng chi (${dateLabel}): ${formatVND(res.total || 0)}` 
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
    
    const { results } = await env.DB.prepare(`
      SELECT DISTINCT strftime('%m', transaction_date) as month 
      FROM transactions 
      WHERE chat_id = ? AND strftime('%Y', transaction_date) = ?
      ORDER BY month ASC
    `).bind(chatId, year).all();

    const keyboard = [];
    let currentRow = [];

    results.forEach((row, index) => {
      currentRow.push({ text: row.month, callback_data: `view_month_${year}_${row.month}` });
      if (currentRow.length === 3 || index === results.length - 1) {
        keyboard.push(currentRow);
        currentRow = [];
      }
    });

    keyboard.push([
      {text: `📊 Total ${year}`, callback_data: `total_year_${year}`},
      {text: `🗂 Categories ${year}`, callback_data: `cat_year_${year}`},
    ]);
    keyboard.push([{text: "⬅️ Back", callback_data: "view_home"}]);

    const text = results.length > 0 ? `Năm ${year}:` : `Chưa có giao dịch nào trong năm ${year}.`;

    await tgAPI('editMessageText', env.TG_TOKEN, { 
      chat_id: chatId, 
      message_id: msgId, 
      text: text, 
      reply_markup: JSON.stringify({ inline_keyboard: keyboard }) 
    });
  } else if (data.startsWith("view_month_")) {
    const parts = data.split("_");
    const year = parts[2];
    const month = parts[3];
    
    const { results } = await env.DB.prepare(`
      SELECT DISTINCT strftime('%d', transaction_date) as day 
      FROM transactions 
      WHERE chat_id = ? AND strftime('%Y-%m', transaction_date) = ?
      ORDER BY day ASC
    `).bind(chatId, `${year}-${month}`).all();

    const keyboard = [];
    let currentRow = [];

    results.forEach((row, index) => {
      currentRow.push({ text: row.day, callback_data: `view_day_${year}_${month}_${row.day}` });
      if (currentRow.length === 4 || index === results.length - 1) {
        keyboard.push(currentRow);
        currentRow = [];
      }
    });

    keyboard.push([
      {text: `📊 Total ${month}/${year}`, callback_data: `total_month_${year}_${month}`},
      {text: `🗂 Categories ${month}/${year}`, callback_data: `cat_month_${year}_${month}`},
    ]);
    keyboard.push([{text: "⬅️ Back", callback_data: `view_year_${year}`}]);

    const text = results.length > 0 ? `Tháng ${month}/${year}:` : `Không có giao dịch.`;

    await tgAPI('editMessageText', env.TG_TOKEN, { 
      chat_id: chatId, 
      message_id: msgId, 
      text: text, 
      reply_markup: JSON.stringify({ inline_keyboard: keyboard }) 
    });
  } else if (data.startsWith("view_day_")) {
    const parts = data.split("_");
    const year = parts[2];
    const month = parts[3];
    const day = parts[4];
    
    const res = await env.DB.prepare(`
      SELECT SUM(amount) as t 
      FROM transactions 
      WHERE chat_id = ? AND type = 'expense' AND date(transaction_date) = ?
    `).bind(chatId, `${year}-${month}-${day}`).first();

    await tgAPI('answerCallbackQuery', env.TG_TOKEN, { 
      callback_query_id: cb.id, 
      text: `Đã chi ngày ${day}/${month}/${year}: ${formatVND(res.t || 0)}\nDùng 🗂 Categories để xem theo danh mục`, 
      show_alert: true 
    });

    await tgAPI('editMessageReplyMarkup', env.TG_TOKEN, {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: `🗂 Categories ${day}/${month}/${year}`, callback_data: `cat_day_${year}_${month}_${day}` }],
          [{ text: "⬅️ Back", callback_data: `view_month_${year}_${month}` }],
        ]
      })
    });
  } else if (data.startsWith("total_month_")) {
    const parts = data.split("_");
    const year = parts[2];
    const month = parts[3];
    
    const res = await env.DB.prepare(`
      SELECT SUM(amount) as t 
      FROM transactions 
      WHERE chat_id = ? AND type = 'expense' AND strftime('%Y-%m', transaction_date) = ?
    `).bind(chatId, `${year}-${month}`).first();
    
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, { 
      callback_query_id: cb.id, 
      text: `Tổng tháng ${month}/${year}: ${formatVND(res.t || 0)}`, 
      show_alert: true 
    });
  } else if (data.startsWith("total_year_")) {
    const year = data.split("_")[2];
    const res = await env.DB.prepare(`
      SELECT SUM(amount) as t 
      FROM transactions 
      WHERE chat_id = ? AND type = 'expense' AND strftime('%Y', transaction_date) = ?
    `).bind(chatId, year).first();
    
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, { 
      callback_query_id: cb.id, 
      text: `Tổng năm ${year}: ${formatVND(res.t || 0)}`, 
      show_alert: true 
    });
  } else if (data === "total_all") {
    const res = await env.DB.prepare(`
      SELECT SUM(amount) as t 
      FROM transactions 
      WHERE chat_id = ? AND type = 'expense'
    `).bind(chatId).first();
    
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, { 
      callback_query_id: cb.id, 
      text: `Tổng tất cả: ${formatVND(res.t || 0)}`, 
      show_alert: true 
    });
  } else if (data.startsWith("cat_year_")) {
    const year = data.split("_")[2];
    const { results } = await env.DB.prepare(`
      SELECT category, SUM(amount) as total
      FROM transactions
      WHERE chat_id = ? AND type = 'expense' AND strftime('%Y', transaction_date) = ?
      GROUP BY category ORDER BY total DESC
    `).bind(chatId, year).all();

    const lines = results.map(r => `${r.category}: ${formatVND(r.total)}`).join('\n');
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, {
      callback_query_id: cb.id,
      text: results.length > 0 ? `Danh mục ${year}:\n${lines}` : `Không có dữ liệu.`,
      show_alert: true,
    });
  } else if (data.startsWith("cat_month_")) {
    const parts = data.split("_");
    const year = parts[2];
    const month = parts[3];
    const { results } = await env.DB.prepare(`
      SELECT category, SUM(amount) as total
      FROM transactions
      WHERE chat_id = ? AND type = 'expense' AND strftime('%Y-%m', transaction_date) = ?
      GROUP BY category ORDER BY total DESC
    `).bind(chatId, `${year}-${month}`).all();

    const lines = results.map(r => `${r.category}: ${formatVND(r.total)}`).join('\n');
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, {
      callback_query_id: cb.id,
      text: results.length > 0 ? `Danh mục ${month}/${year}:\n${lines}` : `Không có dữ liệu.`,
      show_alert: true,
    });
  } else if (data.startsWith("cat_day_")) {
    const parts = data.split("_");
    const year = parts[2];
    const month = parts[3];
    const day = parts[4];
    const { results } = await env.DB.prepare(`
      SELECT category, SUM(amount) as total
      FROM transactions
      WHERE chat_id = ? AND type = 'expense' AND date(transaction_date) = ?
      GROUP BY category ORDER BY total DESC
    `).bind(chatId, `${year}-${month}-${day}`).all();

    const lines = results.map(r => `${r.category}: ${formatVND(r.total)}`).join('\n');
    await tgAPI('answerCallbackQuery', env.TG_TOKEN, {
      callback_query_id: cb.id,
      text: results.length > 0 ? `Danh mục ${day}/${month}/${year}:\n${lines}` : `Không có dữ liệu.`,
      show_alert: true,
    });
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

function parseTransaction(text) {
  const raw = text.trim();
  const match = raw.match(/^(\+?)(\d[\d.,]*)([kKmM]|[tT][rR]\d*)?(.*)$/);
  if (!match) return null;

  const isIncome = match[1] === '+';
  let digits = match[2].replace(/[.,]/g, '');
  const suffix = (match[3] || '').toLowerCase();
  const rest = (match[4] || '').trim();

  let amount = parseInt(digits, 10);
  if (suffix === 'k') {
    amount *= 1000;
  } else if (suffix === 'm') {
    amount *= 1000000;
  } else if (suffix.startsWith('tr')) {
    const extra = suffix.slice(2);
    amount = amount * 1000000 + (extra ? parseInt(extra, 10) * 100000 : 0);
  }

  if (!amount) return null;

  return {
    type: isIncome ? 'income' : 'expense',
    amount,
    category: rest,
  };
}

async function tgAPI(method, token, body) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
