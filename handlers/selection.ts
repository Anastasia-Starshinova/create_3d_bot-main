import { Markup, Telegraf, Context } from 'telegraf';
import { Pool } from 'pg';
import { createSessionMiddleware, cancelProcess, requireSession } from '../utils/session';

const SELECTION_STATES = {
  IDLE: 'idle',
};

function setupSelectionHandlers(bot: Telegraf<Context>, pool: Pool) {
  bot.use(createSessionMiddleware('selectionState', 'selectionData', SELECTION_STATES.IDLE));

  bot.command(['choose', 'select'], async (ctx) => {
    if (!requireSession(ctx)) return;

    const userTelegramId = ctx.from.id.toString();
    await showAllWorkshopButtons(ctx, userTelegramId, pool, bot);
  });

  bot.command(['cancel_selection'], (ctx) => {
    const result = cancelProcess(ctx, 'selectionState', 'selectionData', SELECTION_STATES.IDLE, 'selection');
    ctx.reply(result.message);
  });

  // Handle button clicks for workshop selection
  bot.action(/^select_workshop_(\d+)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1]);
    const workshopTelegramId = ctx.match[2];
    await completeWorkshopSelection(ctx, orderId, workshopTelegramId, pool, bot);
  });

  return async (ctx) => {
    // No text handler needed - all interaction is through buttons
    return false;
  };
}

async function showAllWorkshopButtons(ctx: Context, userTelegramId: string, pool: Pool, bot: Telegraf<Context>) {
  try {
    // Get all orders for the user that have responses and no executor
    const ordersResult = await pool.query(
      `SELECT o.id, o.city, o.description
       FROM orders o
       WHERE o.telegram_id = $1 
         AND o.executor_id IS NULL
         AND EXISTS (
           SELECT 1 FROM responses r WHERE r.order_id = o.id
         )
       ORDER BY o.created_at DESC`,
      [userTelegramId]
    );

    if (ordersResult.rows.length === 0) {
      ctx.reply(
        '❌ You don\'t have any orders with workshop responses yet.\n\n' +
        'Please wait for workshops to respond to your orders, or create a new order with /order.'
      );
      return;
    }

    // Get all responses for all these orders
    const orderIds = ordersResult.rows.map(o => o.id);
    const responsesResult = await pool.query(
      `SELECT r.id as response_id, r.order_id, r.workshop_telegram_id, r.price, r.details,
              w.name as workshop_name, w.city as workshop_city,
              o.city as order_city
       FROM responses r
       LEFT JOIN workshops w ON r.workshop_telegram_id = w.telegram_id
       LEFT JOIN orders o ON r.order_id = o.id
       WHERE r.order_id = ANY($1::int[])
         AND o.executor_id IS NULL
       ORDER BY r.order_id, r.created_at ASC`,
      [orderIds]
    );

    if (responsesResult.rows.length === 0) {
      ctx.reply(
        '❌ No workshop responses found for your orders.\n\n' +
        'Please wait for workshops to respond to your orders.'
      );
      return;
    }

    // Create buttons - one for each workshop (button text = workshop name only)
    const buttons = responsesResult.rows.map(response => {
      const workshopName = (response.workshop_name || 'Unknown Workshop').trim();
      const callbackData = `select_workshop_${response.order_id}_${response.workshop_telegram_id}`;
      return [Markup.button.callback(workshopName, callbackData)];
    });

    const keyboard = Markup.inlineKeyboard(buttons);

    // Build message with list of workshops
    let message = `🔍 Choose a Workshop\n\n`;
    message += `Available workshops that responded to your orders:\n\n`;
    
    // Group by order for better display
    const ordersMap = new Map();
    ordersResult.rows.forEach(order => {
      ordersMap.set(order.id, order);
    });

    let currentOrderId = null;
    responsesResult.rows.forEach((response, index) => {
      if (currentOrderId !== response.order_id) {
        currentOrderId = response.order_id;
        const order = ordersMap.get(response.order_id);
        message += `📦 Order #${response.order_id}\n`;
        message += `   Description: ${order.description}\n`;
        message += `   City: ${order.city}\n\n`;
      }
      
      const workshopName = (response.workshop_name || 'Unknown Workshop').trim();
      const workshopCity = (response.workshop_city || response.order_city || '').trim();
      message += `${index + 1}. ${workshopName}${workshopCity ? `, ${workshopCity}` : ''}\n`;
      message += `   Price: ${response.price}\n`;
      if (response.details) {
        message += `   Details: ${response.details}\n`;
      }
      message += `\n`;
    });

    message += `\nClick a button below to select a workshop:`;

    ctx.reply(message, keyboard);
    
    if (ctx.session) {
      ctx.session.selectionState = SELECTION_STATES.IDLE;
      ctx.session.selectionData = {};
    }
  } catch (error) {
    console.error('Error showing all workshop buttons:', error);
    ctx.reply(
      '❌ Error loading workshops. Please try again or use /cancel_selection to cancel.'
    );
    if (ctx.session) {
      ctx.session.selectionState = SELECTION_STATES.IDLE;
      ctx.session.selectionData = {};
    }
  }
}

async function completeWorkshopSelection(ctx, orderId, workshopTelegramId, pool, bot) {
  const userTelegramId = ctx.from.id.toString();

  try {
    // Get the response details
    const responseResult = await pool.query(
      `SELECT r.id as response_id, r.price, r.details,
              w.name as workshop_name, w.city as workshop_city
       FROM responses r
       LEFT JOIN workshops w ON r.workshop_telegram_id = w.telegram_id
       WHERE r.order_id = $1 AND r.workshop_telegram_id = $2`,
      [orderId, workshopTelegramId]
    );

    if (responseResult.rows.length === 0) {
      ctx.reply('❌ Workshop response not found.');
      return;
    }

    const foundResponse = {
      response_id: responseResult.rows[0].response_id,
      workshop_telegram_id: workshopTelegramId,
      workshop_name: (responseResult.rows[0].workshop_name || 'Unknown Workshop').trim(),
      price: responseResult.rows[0].price,
      details: responseResult.rows[0].details
    };

    // Verify order still doesn't have executor
    const orderCheck = await pool.query(
      'SELECT executor_id, city FROM orders WHERE id = $1 AND telegram_id = $2',
      [orderId, userTelegramId]
    );

    if (orderCheck.rows.length === 0) {
      ctx.reply('❌ Order not found or you don\'t have access to it.');
      return;
    }

    if (orderCheck.rows[0].executor_id) {
      ctx.reply(
        `❌ This order has already been assigned to another workshop. You cannot change the selection.`
      );
      return;
    }

    // Update executor_id
    await pool.query(
      'UPDATE orders SET executor_id = $1 WHERE id = $2',
      [foundResponse.workshop_telegram_id, orderId]
    );

    // Notify the chosen workshop
    try {
      const customerLink = `tg://user?id=${userTelegramId}`;
      const contactKeyboard = Markup.inlineKeyboard([
        [Markup.button.url('Open Customer Profile', customerLink)]
      ]);
      
      await bot.telegram.sendMessage(
        foundResponse.workshop_telegram_id,
        `✅ Your Response Has Been Selected!\n\n` +
        `Order ID: #${orderId}\n` +
        `Customer has chosen you to fulfill this order.\n\n` +
        `Price: ${foundResponse.price}\n` +
        `Details: ${foundResponse.details}\n\n` +
        `Click the button below to contact the customer:`,
        contactKeyboard
      );
    } catch (error) {
      console.error(`Error notifying workshop ${foundResponse.workshop_telegram_id}:`, error);
    }

    // Notify other workshops that they weren't selected
    const allResponsesForOrder = await pool.query(
      `SELECT r.workshop_telegram_id, w.name
       FROM responses r
       LEFT JOIN workshops w ON r.workshop_telegram_id = w.telegram_id
       WHERE r.order_id = $1 AND r.workshop_telegram_id != $2`,
      [orderId, foundResponse.workshop_telegram_id]
    );

    for (const row of allResponsesForOrder.rows) {
      try {
        await bot.telegram.sendMessage(
          row.workshop_telegram_id,
          `ℹ️ Order Update\n\n` +
          `Order ID: #${orderId} has been assigned to another workshop.\n` +
          `Thank you for your response!`
        );
      } catch (error) {
        console.error(`Error notifying workshop ${row.workshop_telegram_id}:`, error);
      }
    }

    const workshopLink = `tg://user?id=${foundResponse.workshop_telegram_id}`;
    const contactKeyboard = Markup.inlineKeyboard([
      [Markup.button.url('Open Workshop Profile', workshopLink)]
    ]);
    
    ctx.reply(
      `✅ Workshop Selected! 🎉\n\n` +
      `You have chosen: ${foundResponse.workshop_name}\n` +
      `Order ID: #${orderId}\n` +
      `Price: ${foundResponse.price}\n` +
      `Details: ${foundResponse.details}\n\n` +
      `Click the button below to contact the workshop:`,
      contactKeyboard
    );
  } catch (error) {
    console.error('Error processing workshop selection:', error);
    ctx.reply(
      '❌ Error processing your selection. Please try again or use /cancel_selection to cancel.'
    );
  }
}

export {
  setupSelectionHandlers,
  SELECTION_STATES,
};
