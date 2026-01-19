import { Telegraf, Context, Markup } from 'telegraf';
import { Pool } from 'pg';
import { createSessionMiddleware, cancelProcess, requireSession } from '../utils/session';

const RESPONSE_STATES = {
  IDLE: 'idle',
  WAITING_FOR_ORDER_ID: 'waiting_for_order_id',
  WAITING_FOR_PRICE: 'waiting_for_price',
  WAITING_FOR_DETAILS: 'waiting_for_details',
};

function setupResponseHandlers(bot: Telegraf<Context>, pool: Pool) {
  bot.use(createSessionMiddleware('responseState', 'responseData', RESPONSE_STATES.IDLE));

  bot.command(['response'], async (ctx) => {
    if (!requireSession(ctx)) return;

    const commandArgs = ctx.message.text.split(' ').slice(1);
    const orderIdArg = commandArgs[0];

    if (orderIdArg) {
      const orderId = parseInt(orderIdArg);
      if (isNaN(orderId) || orderId <= 0) {
        ctx.reply('❌ Invalid order ID. Please use /response <order_id> with a valid number.');
        return;
      }
      await processOrderId(ctx, orderId, pool, bot);
    } else {
      ctx.session.responseState = RESPONSE_STATES.WAITING_FOR_ORDER_ID;
      ctx.session.responseData = {};
      ctx.reply(
        '📝 Respond to Order\n\n' +
        'Please enter the Order ID you want to respond to:'
      );
    }
  });

  bot.command(['cancel_response'], (ctx) => {
    const result = cancelProcess(ctx, 'responseState', 'responseData', RESPONSE_STATES.IDLE, 'response');
    ctx.reply(result.message);
  });

  // Handle button click for responding to order
  bot.action(/^response_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireSession(ctx)) return;

    const orderId = parseInt(ctx.match[1]);
    if (isNaN(orderId) || orderId <= 0) {
      ctx.reply('❌ Invalid order ID.');
      return;
    }

    await processOrderId(ctx, orderId, pool, bot);
  });

  return async (ctx) => {
    if (!ctx.session || !ctx.session.responseState) {
      return false;
    }
    
    const state = ctx.session.responseState;

    if (!ctx.session.responseData) {
      ctx.session.responseData = {};
    }

    if (state === RESPONSE_STATES.WAITING_FOR_ORDER_ID) {
      const orderIdText = ctx.message.text.trim();
      const orderId = parseInt(orderIdText);
      
      if (isNaN(orderId) || orderId <= 0) {
        ctx.reply(
          '❌ Invalid order ID. Please enter a valid positive number.\n\n' +
          'Please enter the order ID or use /cancel_response to cancel:'
        );
        return true;
      }

      await processOrderId(ctx, orderId, pool, bot);
      return true;
    }

    if (state === RESPONSE_STATES.WAITING_FOR_PRICE) {
      const price = ctx.message.text.trim();
      
      if (!price || price.length === 0) {
        ctx.reply(
          '❌ Please enter a valid price.\n\n' +
          'Please enter the approximate price or use /cancel_response to cancel:'
        );
        return true;
      }

      ctx.session.responseData.price = price;
      ctx.session.responseState = RESPONSE_STATES.WAITING_FOR_DETAILS;
      ctx.reply(
        '✅ Price saved!\n\n' +
        'Now please provide any additional details or information about this order:'
      );
      return true;
    }

    if (state === RESPONSE_STATES.WAITING_FOR_DETAILS) {
      const details = ctx.message.text.trim();
      const { orderId, price } = ctx.session.responseData;
      const workshopTelegramId = ctx.from.id;

      try {
        try {
          await pool.query(
            'INSERT INTO responses (order_id, workshop_telegram_id, price, details, created_at) VALUES ($1, $2, $3, $4, $5)',
            [orderId, workshopTelegramId, price, details, new Date()]
          );
        } catch (error) {
          console.error('Error inserting response:', error);
          throw error;
        }

        const orderResult = await pool.query(
          'SELECT telegram_id, description, executor_id FROM orders WHERE id = $1',
          [orderId]
        );

        let customerNotified = false;

        if (orderResult.rows.length > 0 && !orderResult.rows[0].executor_id) {
          const customerTelegramId = orderResult.rows[0].telegram_id;
          const orderDescription = orderResult.rows[0].description;

          const orderCityResult = await pool.query(
            'SELECT city FROM orders WHERE id = $1',
            [orderId]
          );
          const orderCity = orderCityResult.rows[0]?.city || '';

          const allResponsesResult = await pool.query(
            `SELECT r.id, r.workshop_telegram_id, r.price, r.details, w.name as workshop_name, w.city as workshop_city
             FROM responses r
             LEFT JOIN workshops w ON r.workshop_telegram_id = w.telegram_id
             WHERE r.order_id = $1
             ORDER BY r.created_at ASC`,
            [orderId]
          );

          let message = `📦 New Response(s) for Your Order! #${orderId}\n\n`;
          message += `Order: ${orderDescription}\n\n`;
          message += `Available Workshops:\n\n`;

          allResponsesResult.rows.forEach((response, index) => {
            const workshopName = response.workshop_name || `Workshop ${response.workshop_telegram_id}`;
            message += `${index + 1}. ${workshopName}\n`;
            message += `   Price: ${response.price}\n`;
            message += `   Details: ${response.details}\n\n`;
          });

          message += `Click a button below to choose a workshop:`;

          // Create buttons for each workshop
          const buttons = allResponsesResult.rows.map(response => {
            const workshopName = response.workshop_name || `Workshop ${response.workshop_telegram_id}`;
            const callbackData = `select_workshop_${orderId}_${response.workshop_telegram_id}`;
            return [Markup.button.callback(workshopName, callbackData)];
          });

          const keyboard = Markup.inlineKeyboard(buttons);

          try {
            await bot.telegram.sendMessage(
              customerTelegramId,
              message,
              keyboard
            );
            customerNotified = true;
          } catch (error) {
            console.error(`Error notifying customer ${customerTelegramId}:`, error);
          }
        }

        ctx.session.responseState = RESPONSE_STATES.IDLE;
        ctx.session.responseData = {};

        let replyMessage = `✅ Response submitted successfully! 🎉\n\n` +
          `Order ID: ${orderId}\n` +
          `Price: ${price}\n` +
          `Details: ${details}\n\n`;

        if (customerNotified) {
          replyMessage += `The customer has been notified of your response.`;
        } else {
          replyMessage += `⚠️ Note: This order has already been assigned to another workshop, so the customer was not notified.`;
        }

        ctx.reply(replyMessage);
      } catch (error) {
        console.error('Database error:', error);
        ctx.reply(
          '❌ Error saving response. Please try again or use /cancel_response to cancel.'
        );
        ctx.session.responseState = RESPONSE_STATES.IDLE;
        ctx.session.responseData = {};
      }
      return true;
    }

    return false;
  };
}

async function processOrderId(ctx, orderId, pool, bot) {
  try {
    const orderResult = await pool.query(
      'SELECT id, telegram_id, description, city, executor_id FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      ctx.reply(
        `❌ Order with ID ${orderId} does not exist.\n\n` +
        `Please enter a valid order ID or use /cancel_response to cancel:`
      );
      if (ctx.session) {
        ctx.session.responseState = RESPONSE_STATES.WAITING_FOR_ORDER_ID;
      }
      return;
    }

    const order = orderResult.rows[0];

    if (order.executor_id) {
      ctx.reply(
        `⚠️ Warning: This order (ID: ${orderId}) has already been assigned to another workshop.\n\n` +
        `You can still submit a response, but the customer will not be notified since they have already made their choice.`
      );
    }

    if (ctx.session) {
      ctx.session.responseData.orderId = orderId;
      ctx.session.responseState = RESPONSE_STATES.WAITING_FOR_PRICE;
      ctx.reply(
        `✅ Order found!\n\n` +
        `Order ID: ${orderId}\n` +
        `Description: ${order.description}\n` +
        `City: ${order.city}\n\n` +
        `Please enter the approximate price for your service:`
      );
    }
  } catch (error) {
    console.error('Database error:', error);
    ctx.reply(
      '❌ Error checking order. Please try again or use /cancel_response to cancel.'
    );
    if (ctx.session) {
      ctx.session.responseState = RESPONSE_STATES.IDLE;
      ctx.session.responseData = {};
    }
  }
}

export {
  setupResponseHandlers,
  RESPONSE_STATES,
};

