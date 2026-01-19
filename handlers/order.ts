import { Telegraf, Context, Markup } from 'telegraf';
import { Pool } from 'pg';
import { createSessionMiddleware, cancelProcess, requireSession } from '../utils/session';

const ORDER_STATES = {
  IDLE: 'idle',
  WAITING_FOR_DESCRIPTION: 'waiting_for_description',
  WAITING_FOR_CITY: 'waiting_for_city',
};

function setupOrderHandlers(bot: Telegraf<Context>, pool: Pool) {
  bot.use(createSessionMiddleware('orderState', 'orderData', ORDER_STATES.IDLE));

  bot.command(['order', 'print'], (ctx) => {
    if (!requireSession(ctx)) return;
    ctx.session.orderState = ORDER_STATES.WAITING_FOR_DESCRIPTION;
    ctx.session.orderData = {};
    ctx.reply('Let\'s create a new 3D print order! 🖨️\n\nPlease provide a description of your order. Include details such as:\n• Sizes (dimensions)\n• Material (PLA, ABS, PETG, etc.)\n• Color preferences\n• Any other specifications\n\nType your description:');
  });

  bot.command(['cancel_order'], (ctx) => {
    const result = cancelProcess(ctx, 'orderState', 'orderData', ORDER_STATES.IDLE, 'order');
    ctx.reply(result.message);
  });

  return async (ctx) => {
    if (!ctx.session || !ctx.session.orderState) {
      return false;
    }
    
    const state = ctx.session.orderState;

    if (!ctx.session.orderData) {
      ctx.session.orderData = {};
    }

    if (state === ORDER_STATES.WAITING_FOR_DESCRIPTION) {
      ctx.session.orderData.description = ctx.message.text;
      ctx.session.orderState = ORDER_STATES.WAITING_FOR_CITY;
      ctx.reply('Great! Now please enter your city:');
      return true;
    }

    if (state === ORDER_STATES.WAITING_FOR_CITY) {
      const city = ctx.message.text.trim();
      
      try {
        // Check if city exists in workshops table
        const cityCheck = await pool.query(
          'SELECT DISTINCT city FROM workshops WHERE LOWER(city) = LOWER($1)',
          [city]
        );
        
        if (cityCheck.rows.length === 0) {
          // City not found, ask user to try another city or cancel
          ctx.reply(
            `❌ Sorry, we don't have any workshops in "${city}".\n\n` +
            `Please try another city name or use /cancel_order to cancel this order.\n\n` +
            `You can also check available cities by sending any message to see all workshops.`
          );
          return true;
        }
        
        ctx.session.orderData.city = city;
        const telegramId = ctx.from.id;
        const { description } = ctx.session.orderData;
        const createdAt = new Date();
        
        const orderResult = await pool.query(
          'INSERT INTO orders (telegram_id, description, city, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
          [telegramId, description, city, createdAt]
        );
        
        const orderId = orderResult.rows[0].id;
        
        const workshopsResult = await pool.query(
          'SELECT telegram_id FROM workshops WHERE LOWER(city) = LOWER($1)',
          [city]
        );
        
        let successCount = 0;
        let failCount = 0;
        
        for (const row of workshopsResult.rows) {
          const workshopTelegramId = row.telegram_id;
          try {
            const keyboard = Markup.inlineKeyboard([
              [Markup.button.callback('Response to this order', `response_${orderId}`)]
            ]);

            await bot.telegram.sendMessage(
              workshopTelegramId,
              `📦 New Order Received!\n\n` +
              `Order ID: ${orderId}\n` +
              `Customer Telegram ID: ${telegramId}\n` +
              `Description: ${description}\n` +
              `City: ${city}\n\n` +
              `Click the button below to respond to this order.`,
              keyboard
            );
            successCount++;
          } catch (error) {
            console.error(`Error sending message to workshop ${workshopTelegramId}:`, error);
            failCount++;
          }
        }
        
        ctx.session.orderState = ORDER_STATES.IDLE;
        ctx.session.orderData = {};
        
        let replyMessage = `✅ Order created successfully! 🎉\n\n` +
          `Description: ${description}\n` +
          `City: ${city}\n` +
          `Order ID: ${orderId}\n` +
          `Created: ${createdAt.toLocaleString()}\n\n`;
        
        if (workshopsResult.rows.length > 0) {
          replyMessage += `Your order has been sent to ${successCount} workshop(s) in ${city}.`;
          if (failCount > 0) {
            replyMessage += `\n⚠️ Note: ${failCount} workshop(s) could not be notified.`;
          }
        } else {
          replyMessage += `⚠️ Warning: No workshops found in ${city} to notify.`;
        }
        
        ctx.reply(replyMessage);
      } catch (error) {
        console.error('Database error:', error);
        
        if (error.message && error.message.includes('does not exist')) {
          ctx.reply(
            '❌ Database error: Orders table not found. Please contact the administrator.\n\n' +
            'Order cancelled.'
          );
        } else {
          ctx.reply(
            'Sorry, there was an error saving the order. Please try again with /order'
          );
        }
        ctx.session.orderState = ORDER_STATES.IDLE;
        ctx.session.orderData = {};
      }
      return true;
    }

    return false;
  };
}

export {
  setupOrderHandlers,
  ORDER_STATES,
};

