import { Context } from 'telegraf';

/**
 * Initialize session state and data if they don't exist
 * @param ctx - Telegraf context
 * @param stateName - Name of the state property (e.g., 'orderState')
 * @param dataName - Name of the data property (e.g., 'orderData')
 * @param defaultState - Default state value (e.g., 'idle')
 */
export function initializeSession(
  ctx: Context,
  stateName: string,
  dataName: string,
  defaultState: string
): void {
  if (ctx.session) {
    const session = ctx.session as any;
    if (!session[stateName]) {
      session[stateName] = defaultState;
    }
    if (!session[dataName]) {
      session[dataName] = {};
    }
  }
}

/**
 * Create a middleware function that initializes session state and data
 * @param stateName - Name of the state property (e.g., 'orderState')
 * @param dataName - Name of the data property (e.g., 'orderData')
 * @param defaultState - Default state value (e.g., 'idle')
 * @returns Middleware function
 */
export function createSessionMiddleware(
  stateName: string,
  dataName: string,
  defaultState: string
) {
  return (ctx: Context, next: () => Promise<void>) => {
    initializeSession(ctx, stateName, dataName, defaultState);
    return next();
  };
}

/**
 * Check if session exists, reply with error if not
 * @param ctx - Telegraf context
 * @returns true if session exists, false otherwise (and replies with error)
 */
export function requireSession(ctx: Context): boolean {
  if (!ctx.session) {
    ctx.reply('Session error. Please try /reset and try again.');
    return false;
  }
  return true;
}

/**
 * Cancel an active process by resetting state and data
 * @param ctx - Telegraf context
 * @param stateName - Name of the state property (e.g., 'orderState')
 * @param dataName - Name of the data property (e.g., 'orderData')
 * @param idleState - Idle state value (e.g., 'idle')
 * @param processName - Name of the process for error messages (e.g., 'order', 'response')
 * @returns Object with success boolean and message string
 */
export function cancelProcess(
  ctx: Context,
  stateName: string,
  dataName: string,
  idleState: string,
  processName: string
): { success: boolean; message: string } {
  if (!requireSession(ctx)) {
    return {
      success: false,
      message: 'Session error. Please try /reset and try again.'
    };
  }

  const session = ctx.session as any;
  
  if (session[stateName] !== idleState) {
    session[stateName] = idleState;
    session[dataName] = {};
    return {
      success: true,
      message: `${processName.charAt(0).toUpperCase() + processName.slice(1)} cancelled.`
    };
  } else {
    return {
      success: false,
      message: `There is no active ${processName} to cancel.`
    };
  }
}

