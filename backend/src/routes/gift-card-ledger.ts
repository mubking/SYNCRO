import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { giftCardLedgerService } from '../services/gift-card-ledger-service';
import { validateRequest } from '../utils/validation';
import { BadRequestError } from '../errors';
import { validateLimit } from '../utils/pagination';

const router = Router();
router.use(authenticate);

const topUpSchema = z.object({
  amount: z.number().positive(),
  description: z.string().max(255).optional(),
});

const deductSchema = z.object({
  subscriptionId: z.string().uuid(),
  amount: z.number().positive(),
  description: z.string().max(255).optional(),
});

/** GET /api/gift-card-ledger/balance */
router.get('/balance', async (req: AuthenticatedRequest, res: Response) => {
  const balance = await giftCardLedgerService.getBalance(req.user!.id);
  res.json({ success: true, balance, formatted: `$${balance.toFixed(2)} remaining` });
});

/** GET /api/gift-card-ledger/history */
router.get('/history', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = validateLimit(req.query.limit, 100, 50);
    const history = await giftCardLedgerService.getHistory(req.user!.id, limit);
    res.json({ success: true, data: history });
  } catch (error: any) {
    if (error.name === 'PaginationError') {
      throw new BadRequestError(error.message);
    }
    throw error;
  }
});

/** POST /api/gift-card-ledger/top-up */
router.post('/top-up', async (req: AuthenticatedRequest, res: Response) => {
  const { amount, description } = validateRequest(topUpSchema, req.body);
  const entry = await giftCardLedgerService.topUp(req.user!.id, amount, description);
  res.status(201).json({ success: true, data: entry });
});

/** POST /api/gift-card-ledger/deduct */
router.post('/deduct', async (req: AuthenticatedRequest, res: Response) => {
  const { subscriptionId, amount, description } = validateRequest(deductSchema, req.body);
  try {
    const entry = await giftCardLedgerService.deduct(req.user!.id, subscriptionId, amount, description);
    res.status(201).json({ success: true, data: entry });
  } catch (err: any) {
    if (err.message?.startsWith('Insufficient balance')) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
});

export default router;
