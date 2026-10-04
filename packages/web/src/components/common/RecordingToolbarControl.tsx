import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Chip, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircle, faStop } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useHasMinRole } from '../../store/authStore';
import { UserRole, type AudioRecordingStatus } from '@tx5dr/contracts';
import { getApiUrl } from '../../utils/config';
import { createLogger } from '../../utils/logger';

const logger = createLogger('RecordingToolbarControl');

export function RecordingToolbarControl(): React.ReactElement | null {
  const { t } = useTranslation('common');
  const canOperate = useHasMinRole(UserRole.OPERATOR);
  const [status, setStatus] = useState<AudioRecordingStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(getApiUrl('/recording/status'));
      if (!response.ok) return;
      const payload = await response.json() as { status?: AudioRecordingStatus };
      if (payload.status) setStatus(payload.status);
    } catch (error) {
      logger.debug('Failed to load recording status', error);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  const isRecording = status?.state === 'recording' || status?.state === 'stopping';
  const label = useMemo(() => {
    if (status?.state === 'error') return t('recording.error');
    if (isRecording) return t('recording.stop');
    return t('recording.start');
  }, [isRecording, status?.state, t]);

  if (!canOperate) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      const endpoint = isRecording ? '/recording/stop' : '/recording/start';
      const response = await fetch(getApiUrl(endpoint), { method: 'POST' });
      const payload = await response.json() as { status?: AudioRecordingStatus; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || t('recording.requestFailed'));
      if (payload.status) setStatus(payload.status);
    } catch (error) {
      logger.warn('Recording toggle failed', error);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {isRecording && status?.durationMs !== undefined ? (
        <Chip size="sm" color="danger" variant="flat">{Math.floor(status.durationMs / 1000)}s</Chip>
      ) : null}
      <Tooltip content={label}>
        <Button
          isIconOnly
          size="sm"
          variant={isRecording ? 'solid' : 'light'}
          color={isRecording ? 'danger' : 'default'}
          isLoading={busy}
          onPress={() => void toggle()}
          aria-label={label}
          title={label}
        >
          <FontAwesomeIcon icon={isRecording ? faStop : faCircle} className={isRecording ? '' : 'text-danger'} />
        </Button>
      </Tooltip>
    </div>
  );
}
