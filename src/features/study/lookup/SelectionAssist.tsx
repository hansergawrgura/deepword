import { useEffect, useState, type RefObject } from 'react';
import { useT } from '@/i18n';
import { IconSparkle } from '@/ui/icons';
import type { LookupAnchor } from './useStudyLookup';

export interface SelectionAssistProps {
  /** 限定选区所在容器；选区不在其中则不显示。 */
  rootRef: RefObject<HTMLElement | null>;
  onExplain: (text: string, anchor: LookupAnchor) => void;
}

interface AssistState {
  text: string;
  top: number;
  left: number;
}

function selectionInside(root: HTMLElement, selection: Selection): boolean {
  if (selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(el && root.contains(el));
}

export default function SelectionAssist({ rootRef, onExplain }: SelectionAssistProps) {
  const t = useT();
  const [assist, setAssist] = useState<AssistState | null>(null);

  useEffect(() => {
    const update = () => {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.isCollapsed || !selectionInside(root, selection)) {
        setAssist(null);
        return;
      }
      const text = selection.toString().replace(/\s+/g, ' ').trim();
      if (text.length < 2) {
        setAssist(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setAssist(null);
        return;
      }
      setAssist({
        text,
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    };

    const onMouseUp = () => {
      // 等浏览器落定选区再量位置。
      window.setTimeout(update, 0);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift' || event.key.startsWith('Arrow')) onMouseUp();
    };

    document.addEventListener('selectionchange', update);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [rootRef]);

  if (!assist) return null;

  return (
    <button
      type="button"
      className="study-selection-assist"
      style={{ top: assist.top, left: assist.left }}
      title={t('study.selectionTitle')}
      aria-label={t('study.selectionTitle')}
      onMouseDown={(event) => {
        // 避免 mousedown 清掉选区。
        event.preventDefault();
      }}
      onClick={() => {
        onExplain(assist.text, { top: assist.top + 28, left: assist.left });
        setAssist(null);
        window.getSelection()?.removeAllRanges();
      }}
    >
      <IconSparkle size={14} />
    </button>
  );
}
