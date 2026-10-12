import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';

export interface SortableItem {
  readonly id: string;
  readonly content: ReactNode;
}

function Row({
  item,
  index,
  total,
  onMove,
  disabled,
}: {
  item: SortableItem;
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-md border bg-card px-2 py-1.5',
        isDragging && 'z-10 shadow-lg',
      )}
    >
      <button
        type="button"
        className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
        aria-label="Перетащить"
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      <div className="min-w-0 flex-1">{item.content}</div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Выше"
        disabled={disabled || index === 0}
        onClick={() => onMove(index, index - 1)}
      >
        <ArrowUp aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Ниже"
        disabled={disabled || index === total - 1}
        onClick={() => onMove(index, index + 1)}
      >
        <ArrowDown aria-hidden />
      </Button>
    </li>
  );
}

/**
 * Порядок перетаскиванием (ADR-012): мышью и пальцем за ручку, с клавиатуры и кнопками «Выше / Ниже»
 * (они же — запасной путь, если перетаскивание неудобно). `onReorder` получает новый порядок id.
 */
export function SortableList({
  items,
  onReorder,
  disabled = false,
  label,
}: {
  items: readonly SortableItem[];
  onReorder: (ids: string[]) => void;
  disabled?: boolean;
  label: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map((i) => i.id);
  const move = (from: number, to: number) => onReorder(arrayMove(ids, from, to));
  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul aria-label={label} className="space-y-1.5">
          {items.map((item, index) => (
            <Row
              key={item.id}
              item={item}
              index={index}
              total={items.length}
              onMove={move}
              disabled={disabled}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
