/**
 * User Data Routes — GDPR compliance (issue #294)
 * GET  /api/user/export-data  — download all personal data as JSON
 * DELETE /api/user/account    — cascade-delete all user data + auth record
 */

import express, { Response } from 'express';
import { supabase } from '../config/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import logger from '../config/logger';
import { roleService } from '../services/role-service';

const router = express.Router();
router.use(authenticate);

/**
 * GET /api/user/role
 * Returns the current user's role from the authoritative source
 */
router.get('/role', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const role = await roleService.getUserRole(userId);

    return res.status(200).json({
      user_id: userId,
      role,
    });
  } catch (error) {
    logger.error('Error getting user role:', error);
    return res.status(500).json({ success: false, error: 'Failed to get user role' });
  }
});

/**
 * GET /api/user/export-data
 * Returns a JSON bundle of every record belonging to the authenticated user.
 */
router.get('/export-data', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const [
      { data: profile },
      { data: subscriptions },
      { data: emailAccounts },
      { data: teamMembers },
      { data: notifications },
      { data: tags },
    ] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('subscriptions').select('*').eq('user_id', userId),
      supabase.from('email_accounts').select('*').eq('user_id', userId),
      supabase.from('team_members').select('*').eq('user_id', userId),
      supabase.from('notifications').select('*').eq('user_id', userId),
      supabase.from('tags').select('*').eq('user_id', userId),
    ]);

    const exportData = {
      exported_at: new Date().toISOString(),
      user_id: userId,
      profile,
      subscriptions: subscriptions ?? [],
      email_accounts: emailAccounts ?? [],
      team_members: teamMembers ?? [],
      notifications: notifications ?? [],
      tags: tags ?? [],
    };

    res.setHeader('Content-Disposition', 'attachment; filename="syncro-data-export.json"');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(exportData);
  } catch (error) {
    logger.error('Error exporting user data:', error);
    return res.status(500).json({ success: false, error: 'Failed to export data' });
  }
});

/**
 * DELETE /api/user/account
 * Cascade-deletes all records belonging to the user, then removes the auth account.
 */
router.delete('/account', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    // Delete user-owned rows from every related table (order respects FK constraints)
    const tables = [
      'notifications',
      'tags',
      'email_accounts',
      'team_members',
      'subscriptions',
      'profiles',
    ];

    for (const table of tables) {
      const { error } = await supabase.from(table).delete().eq('user_id', userId);
      if (error) {
        logger.error(`Error deleting from ${table} for user ${userId}:`, error);
      }
    }

    // Remove the auth record using the service-role client
    const { error: authError } = await supabase.auth.admin.deleteUser(userId);
    if (authError) {
      logger.error('Error deleting auth user:', authError);
      return res.status(500).json({ success: false, error: 'Failed to delete account' });
    }

    logger.info('User account deleted (GDPR)', { user_id: userId });
    return res.status(200).json({ success: true, message: 'Account and all associated data have been deleted.' });
  } catch (error) {
    logger.error('Error deleting user account:', error);
    return res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
});

export default router;
