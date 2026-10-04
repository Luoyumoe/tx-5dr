import React, { forwardRef, useImperativeHandle, useEffect, useState } from 'react';
import { Input, Select, SelectItem } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { getApiUrl } from '../../utils/config';
import type { AudioRecordingSettings } from '@tx5dr/contracts';

export interface RecordingSettingsRef {
  save: () => Promise<void>;
  hasUnsavedChanges: () => boolean;
}

const defaults: AudioRecordingSettings = {
  format: 'wav', quality: 'medium', source: 'rx', directory: '/tmp/tx5dr-recordings',
};

export const RecordingSettings = forwardRef<RecordingSettingsRef, { onUnsavedChanges?: (value: boolean) => void }>(function RecordingSettings({ onUnsavedChanges }, ref) {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<AudioRecordingSettings>(defaults);
  const [original, setOriginal] = useState<AudioRecordingSettings>(defaults);

  useEffect(() => {
    void fetch(getApiUrl('/settings/recording')).then((response) => response.json()).then((payload: { settings?: AudioRecordingSettings }) => {
      if (payload.settings) {
        setSettings(payload.settings);
        setOriginal(payload.settings);
      }
    }).catch(() => undefined);
  }, []);

  const hasChanges = () => JSON.stringify(settings) !== JSON.stringify(original);
  useEffect(() => { onUnsavedChanges?.(hasChanges()); }, [settings, original, onUnsavedChanges]);
  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: hasChanges,
    save: async () => {
      const response = await fetch(getApiUrl('/settings/recording'), {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error(t('recording.saveFailed'));
      setOriginal(settings);
    },
  }), [settings, t]);

  return (
    <div className="flex flex-col gap-5 max-w-xl">
      <div>
        <h3 className="text-xl font-bold">{t('recording.title')}</h3>
        <p className="text-sm text-default-500">{t('recording.description')}</p>
      </div>
      <Select label={t('recording.format')} selectedKeys={[settings.format]} onSelectionChange={(keys) => setSettings({ ...settings, format: String(Array.from(keys)[0]) as AudioRecordingSettings['format'] })}>
        <SelectItem key="wav">WAV</SelectItem>
        <SelectItem key="mp3">MP3</SelectItem>
      </Select>
      <Select label={t('recording.quality')} selectedKeys={[settings.quality]} onSelectionChange={(keys) => setSettings({ ...settings, quality: String(Array.from(keys)[0]) as AudioRecordingSettings['quality'] })}>
        <SelectItem key="low">{t('recording.qualityLow')}</SelectItem>
        <SelectItem key="medium">{t('recording.qualityMedium')}</SelectItem>
        <SelectItem key="high">{t('recording.qualityHigh')}</SelectItem>
      </Select>
      <Select label={t('recording.source')} selectedKeys={[settings.source]} onSelectionChange={(keys) => setSettings({ ...settings, source: String(Array.from(keys)[0]) as AudioRecordingSettings['source'] })}>
        <SelectItem key="rx">{t('recording.sourceRx')}</SelectItem>
        <SelectItem key="tx">{t('recording.sourceTx')}</SelectItem>
        <SelectItem key="both">{t('recording.sourceBoth')}</SelectItem>
      </Select>
      <Input label={t('recording.directory')} value={settings.directory} onValueChange={(directory) => setSettings({ ...settings, directory })} description={t('recording.directoryHelp')} />
    </div>
  );
});
