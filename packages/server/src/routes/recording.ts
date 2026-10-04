import type { FastifyInstance } from 'fastify';
import {
  AudioRecordingSettingsSchema,
  AudioRecordingSettingsResponseSchema,
  AudioRecordingStatusResponseSchema,
  UserRole,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { requireAbility, requireRole } from '../auth/authPlugin.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

export async function recordingRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();

  fastify.get('/status', { preHandler: [requireRole(UserRole.VIEWER)] }, async (_request, reply) => {
    return reply.send(AudioRecordingStatusResponseSchema.parse({
      success: true,
      status: engine.getRecordingService().getStatus(),
    }));
  });

  fastify.post('/start', {
    preHandler: [requireAbility('execute', 'AudioRecording')],
  }, async (_request, reply) => {
    try {
      const status = await engine.getRecordingService().start();
      return reply.send(AudioRecordingStatusResponseSchema.parse({ success: true, status }));
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.post('/stop', {
    preHandler: [requireAbility('execute', 'AudioRecording')],
  }, async (_request, reply) => {
    try {
      const status = await engine.getRecordingService().stop();
      return reply.send(AudioRecordingStatusResponseSchema.parse({ success: true, status }));
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}

export async function recordingSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  const configManager = ConfigManager.getInstance();

  fastify.get('/recording', { preHandler: [requireRole(UserRole.ADMIN)] }, async (_request, reply) => {
    return reply.send(AudioRecordingSettingsResponseSchema.parse({
      success: true,
      settings: configManager.getRecordingSettings(),
    }));
  });

  fastify.put('/recording', { preHandler: [requireRole(UserRole.ADMIN)] }, async (request, reply) => {
    try {
      const settings = AudioRecordingSettingsSchema.partial().parse(request.body);
      const saved = await configManager.updateRecordingSettings(settings);
      return reply.send(AudioRecordingSettingsResponseSchema.parse({ success: true, settings: saved }));
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });
}
