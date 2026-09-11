import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, GripVertical, Trash2 } from "lucide-react";
import { SlideThumbnail } from "./SlideThumbnail";

export interface SlideRailProps {
  slideCount: number;
  activeSlide: number;
  previewUrl: string | null;
  mutationsEnabled?: boolean;
  selectionEnabled?: boolean;
  onSelect(index: number): void;
  onReorder(fromIndex: number, toIndex: number): void;
  onDuplicate(index: number): void;
  onDelete(index: number): void;
}

interface SortableSlideProps {
  index: number;
  activeSlide: number;
  previewUrl: string | null;
  mutationsEnabled: boolean;
  selectionEnabled: boolean;
  slideCount: number;
  onSelect(index: number): void;
  onDuplicate(index: number): void;
  onDelete(index: number): void;
}

const slideId = (index: number) => `slide-${index}`;

function StaticSlide({
  index,
  activeSlide,
  previewUrl,
  selectionEnabled,
  slideCount,
  onSelect,
  onDuplicate,
  onDelete,
}: Omit<SortableSlideProps, "mutationsEnabled">) {
  const active = index === activeSlide;

  return (
    <li
      className="slide-rail__item"
      data-dragging="false"
      data-slide-id={slideId(index)}
    >
      <div className="slide-rail__item-header">
        <span className="slide-rail__number">{index}</span>
        <div className="slide-rail__item-actions">
          <button
            type="button"
            className="slide-rail__icon-button"
            aria-label={`슬라이드 ${index} 이동`}
            title={`슬라이드 ${index} 이동`}
            disabled
          >
            <GripVertical aria-hidden="true" size={15} />
          </button>
          <button
            type="button"
            className="slide-rail__icon-button"
            aria-label={`슬라이드 ${index} 복제`}
            title={`슬라이드 ${index} 복제`}
            disabled
            onClick={() => onDuplicate(index)}
          >
            <Copy aria-hidden="true" size={14} />
          </button>
          <button
            type="button"
            className="slide-rail__icon-button"
            aria-label={`슬라이드 ${index} 삭제`}
            title={`슬라이드 ${index} 삭제`}
            disabled={slideCount >= 1}
            onClick={() => onDelete(index)}
          >
            <Trash2 aria-hidden="true" size={14} />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="slide-rail__select"
        aria-label={`슬라이드 ${index} 선택`}
        aria-current={active ? "true" : undefined}
        disabled={!selectionEnabled}
        onClick={() => onSelect(index)}
      >
        <SlideThumbnail
          index={index}
          previewUrl={previewUrl}
          active={active}
          fallbackVisible={Math.abs(index - activeSlide) <= 1}
        />
      </button>
    </li>
  );
}

function SortableSlide({
  index,
  activeSlide,
  previewUrl,
  mutationsEnabled,
  selectionEnabled,
  slideCount,
  onSelect,
  onDuplicate,
  onDelete,
}: SortableSlideProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: slideId(index),
    disabled: !mutationsEnabled,
  });
  const active = index === activeSlide;

  return (
    <li
      ref={setNodeRef}
      className="slide-rail__item"
      data-dragging={isDragging ? "true" : "false"}
      data-slide-id={slideId(index)}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className="slide-rail__item-header">
        <span className="slide-rail__number">{index}</span>
        <div className="slide-rail__item-actions">
          <button
            type="button"
            className="slide-rail__icon-button"
            aria-label={`슬라이드 ${index} 이동`}
            title={`슬라이드 ${index} 이동`}
            disabled={!mutationsEnabled}
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" size={15} />
          </button>
          <button
            type="button"
            className="slide-rail__icon-button"
            aria-label={`슬라이드 ${index} 복제`}
            title={`슬라이드 ${index} 복제`}
            disabled={!mutationsEnabled}
            onClick={() => onDuplicate(index)}
          >
            <Copy aria-hidden="true" size={14} />
          </button>
          <button
            type="button"
            className="slide-rail__icon-button"
            aria-label={`슬라이드 ${index} 삭제`}
            title={`슬라이드 ${index} 삭제`}
            disabled={!mutationsEnabled || slideCount === 1}
            onClick={() => onDelete(index)}
          >
            <Trash2 aria-hidden="true" size={14} />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="slide-rail__select"
        aria-label={`슬라이드 ${index} 선택`}
        aria-current={active ? "true" : undefined}
        disabled={!selectionEnabled}
        onClick={() => onSelect(index)}
      >
        <SlideThumbnail
          index={index}
          previewUrl={previewUrl}
          active={active}
          fallbackVisible={Math.abs(index - activeSlide) <= 1}
        />
      </button>
    </li>
  );
}

export function SlideRail({
  slideCount,
  activeSlide,
  previewUrl,
  mutationsEnabled = true,
  selectionEnabled = true,
  onSelect,
  onReorder,
  onDuplicate,
  onDelete,
}: SlideRailProps) {
  const slides = Array.from(
    { length: Math.max(0, slideCount) },
    (_, offset) => offset + 1,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const fromIndex = slides.findIndex(
      (index) => slideId(index) === active.id,
    );
    const toIndex = slides.findIndex(
      (index) => slideId(index) === over.id,
    );
    if (fromIndex < 0 || toIndex < 0) return;
    onReorder(fromIndex, toIndex);
  };

  const staticSlides = slides.map((index) => (
    <StaticSlide
      key={index}
      index={index}
      activeSlide={activeSlide}
      previewUrl={previewUrl}
      selectionEnabled={selectionEnabled}
      slideCount={slideCount}
      onSelect={onSelect}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
    />
  ));

  return (
    <aside aria-label="슬라이드 목록" className="slide-rail">
      <div className="slide-rail__title">슬라이드</div>
      <div className="slide-rail__scroll">
        {mutationsEnabled ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={slides.map(slideId)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="slide-rail__list">
                {slides.map((index) => (
                  <SortableSlide
                    key={index}
                    index={index}
                    activeSlide={activeSlide}
                    previewUrl={previewUrl}
                    mutationsEnabled
                    selectionEnabled={selectionEnabled}
                    slideCount={slideCount}
                    onSelect={onSelect}
                    onDuplicate={onDuplicate}
                    onDelete={onDelete}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        ) : (
          <ol className="slide-rail__list">{staticSlides}</ol>
        )}
      </div>
    </aside>
  );
}
