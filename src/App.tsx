import { createSignal, createEffect, onMount, For, Show, batch } from 'solid-js';
import { invoke } from "@tauri-apps/api/core";
import { load as loadTauriStore, Store as TauriStoreType } from '@tauri-apps/plugin-store';
// Для Drag and Drop в Solid.js, например @thisbeyond/solid-dnd
import {
  createDraggable,
  createDroppable,
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider
} from "@thisbeyond/solid-dnd";
import type { DragEvent } from "@thisbeyond/solid-dnd";

import './App.css';
interface Task {
  id: string;
  content: string;
  time_spent_ms: number;
}

interface Column {
  id: string;
  title: string;
  taskIds: string[];
}

interface KanbanData {
  tasks: Record<string, Task>;
  columns: Record<string, Column>;
  columnOrder: string[];
}

// Глобальная переменная для хранения инстанса стора после загрузки
let storeInstance: TauriStoreType | null = null;

// Асинхронная функция для получения/инициализации стора
async function getStore(): Promise<TauriStoreType> {
  if (!storeInstance) {
    // autoSave: false означает, что мы должны вызывать .save() явно
    storeInstance = await loadTauriStore('tasks.json', { autoSave: false });
  }
  return storeInstance;
}

const initialKanbanData: KanbanData = {
  tasks: {},
  columns: {
    'queue': { id: 'queue', title: 'Очередь', taskIds: [] },
    'inProgress': { id: 'inProgress', title: 'В работе', taskIds: [] },
    'review': { id: 'review', title: 'На проверке', taskIds: [] },
    'done': { id: 'done', title: 'Готово', taskIds: [] },
  },
  columnOrder: ['queue', 'inProgress', 'review', 'done'],
};

// Обновляем props DraggableTask
interface DraggableTaskProps {
  task: Task;
  isActive: boolean;
  onSelect: (id: string) => void;
  columnId: string;
  onDelete: (taskId: string, columnId: string) => void; // <--- НОВЫЙ ПРОПС
}

// ---> НАЧАЛО ЗАМЕНЫ DraggableTask <---

const DraggableTask = (props: DraggableTaskProps) => {
  const draggable = createDraggable(props.task.id);
  // Добавляем droppable для каждой задачи
  const droppable = createDroppable(props.task.id); // <--- ДОБАВЛЕНО

  return (
    <div
      // @ts-ignore
      use:draggable
      // @ts-ignore
      use:droppable // <--- ДОБАВЛЕНО
      style={draggable.isActiveDraggable ? { "opacity": "0.5" } : {}}
      class={`task-card ${props.isActive ? 'active-task' : ''}`}
      classList={{ "solid-draggable-active": draggable.isActiveDraggable, "solid-droppable-active": droppable.isActiveDroppable }} // <--- ОБНОВЛЕНО
      onClick={() => {
        // Разрешаем выбор задачи только из колонки "В работе"
        if (props.columnId === 'inProgress') {
          props.onSelect(props.task.id);
        }
      }}
      title={props.columnId === 'inProgress' ? "Кликните, чтобы сделать задачу активной для таймера" : props.task.content}
    >
      {/* Обертка для контента задачи, чтобы кнопка удаления не перекрывала его */}
      <div class="task-content-wrapper">
        {props.task.content}
      </div>

      <div class="task-time">{formatTime(props.task.time_spent_ms)}</div>

      {/* КНОПКА УДАЛЕНИЯ */}
      <button
        class="delete-task-button"
        onClick={(e) => {
          e.stopPropagation(); // ОЧЕНЬ ВАЖНО! Предотвращаем всплытие клика
          props.onDelete(props.task.id, props.columnId); // Вызываем переданную функцию удаления
        }}
        title="Удалить задачу"
      >
        &times; {/* Или <svg>...</svg> */}
      </button>
    </div>
  );
};


// Обновляем props DroppableColumn
interface DroppableColumnProps {
  column: Column;
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onDeleteTask: (taskId: string, columnId: string) => void; // <--- ДОБАВЛЕНО
}

const DroppableColumn = (props: DroppableColumnProps) => {
  const droppable = createDroppable(props.column.id);
  return (
    <div
      // @ts-ignore
      use:droppable
      class="kanban-column"
      classList={{ "solid-droppable-active": droppable.isActiveDroppable }}
    >
      <h3>{props.column.title}</h3>
      {/* Оборачиваем в SortableProvider */}
      <SortableProvider ids={props.tasks.map(t => t.id)}>
        <For each={props.tasks}>
          {(task) => (
            <DraggableTask
              task={task}
              isActive={props.activeTaskId === task.id}
              onSelect={props.onSelectTask}
              columnId={props.column.id}
              onDelete={props.onDeleteTask}
            />
          )}
        </For>
      </SortableProvider>
    </div>
  );
};



// --- Основной компонент App ---
function App() {
  const [isExpanded, setIsExpanded] = createSignal(false);
  const [currentTimeDisplay, setCurrentTimeDisplay] = createSignal('00:00:00');
  const [activeTaskId, setActiveTaskIdState] = createSignal<string | null>(null);
  const [isTimerRunning, setIsTimerRunning] = createSignal(false);

  const [newTaskContent, setNewTaskContent] = createSignal('');
  const [kanbanData, setKanbanData] = createSignal<KanbanData>(initialKanbanData);
  const [isStoreLoaded, setIsStoreLoaded] = createSignal(false);

  const [activeDragItem, setActiveDragItem] = createSignal<string | null>(null);

  const saveKanbanDataToStore = async (dataToSave: KanbanData, currentActiveTaskId: string | null) => {
    try {
      const store = await getStore();
      await store.set('tasks', dataToSave.tasks);
      await store.set('columns', dataToSave.columns);
      await store.set('columnOrder', dataToSave.columnOrder);
      await store.set('activeTaskId', currentActiveTaskId);
      await store.save(); // Явное сохранение, так как autoSave: false
      console.log("Данные Kanban сохранены в store (Solid, v2 API).");
    } catch (error) {
      console.error("Ошибка сохранения данных Kanban в store (Solid, v2 API):", error);
    }
  };

  const loadDataFromStore = async () => {
    try {
      const store = await getStore(); // Получаем или инициализируем стор
      // store.load() не нужен, так как loadTauriStore уже загружает данные

      const storedTasks = await store.get<Record<string, Task>>('tasks');
      const storedColumns = await store.get<Record<string, Column>>('columns');
      const storedColumnOrder = await store.get<string[]>('columnOrder');
      const storedActiveTaskId = await store.get<string | null>('activeTaskId');

      if (storedTasks && storedColumns && storedColumnOrder) {
        const loadedData = {
          tasks: storedTasks,
          columns: storedColumns,
          columnOrder: storedColumnOrder,
        };
        batch(() => {
          setKanbanData(loadedData);
          setActiveTaskIdState(storedActiveTaskId ?? null);
        });

        if (storedActiveTaskId && loadedData.tasks[storedActiveTaskId]) {
          const activeTask = loadedData.tasks[storedActiveTaskId];
          await invoke('sync_task_to_rust_db', { task: activeTask });
          setCurrentTimeDisplay(formatTime(activeTask.time_spent_ms));
        }
        console.log("Данные Kanban загружены из store (Solid, v2 API).");
      } else {
        setKanbanData(initialKanbanData);
        setActiveTaskIdState(null);
        await saveKanbanDataToStore(initialKanbanData, null); // Сохраняем начальные данные
        console.log("Store инициализирован начальными данными Kanban (Solid, v2 API).");
      }
    } catch (error) {
      console.error("Ошибка загрузки данных из store (Solid, v2 API):", error);
      setKanbanData(initialKanbanData);
      setActiveTaskIdState(null);
    } finally {
      setIsStoreLoaded(true);
    }
  };

  const deleteTask = async (taskId: string, columnId: string) => {
    // Остановка таймера, если удаляемая задача была активной
    if (activeTaskId() === taskId && isTimerRunning()) {
      try {
        const pausedTask: Task | null = await invoke('pause_timer');
      } catch (e) {
        console.error("Ошибка при паузе таймера перед удалением (Solid):", e);
      }
    }

    // Обновление состояния канбан-данных и активной задачи атомарно с batch
    batch(() => {
      setKanbanData(prevData => {
        const newColumns = { ...prevData.columns };
        const column = newColumns[columnId];
        if (!column) return prevData; // Колонка не найдена

        // Удаление ID задачи из списка taskIds в колонке
        const newTaskIds = column.taskIds.filter(id => id !== taskId);
        newColumns[columnId] = {
          ...column,
          taskIds: newTaskIds,
        };

        // Удаление самой задачи из объекта tasks
        const newTasks = { ...prevData.tasks };
        delete newTasks[taskId];

        const updatedData = {
          ...prevData,
          columns: newColumns,
          tasks: newTasks,
        };
        return updatedData; // Возвращаем новое состояние
      });

      // Если удалили активную задачу, сбрасываем активный статус таймера
      if (activeTaskId() === taskId) {
        setActiveTaskIdState(null);
        setIsTimerRunning(false);
        setCurrentTimeDisplay(formatTime(0)); // Сбрасываем отображение времени
      }
    }); // Конец batch

    // Сохраняем обновленные данные (состояние kanbanData уже обновлено после batch)
    // Передаем актуальное значение activeTaskId() после потенциального сброса
    await saveKanbanDataToStore(kanbanData(), activeTaskId());

    console.log(`Задача ${taskId} удалена из колонки ${columnId}`);
  };

  onMount(loadDataFromStore);

  createEffect(() => {
    if (!isStoreLoaded()) return;

    const interval = setInterval(async () => {
      if (isTimerRunning() && activeTaskId()) {
        try {
          const result: [string, number] | null = await invoke('get_current_task_time');
          if (result) {
            const [taskIdFromResult, timeMs] = result;
            if (taskIdFromResult === activeTaskId()) {
              setCurrentTimeDisplay(formatTime(timeMs));
            }
          }
        } catch (e) {
          console.error("Ошибка получения времени задачи (Solid):", e);
        }
      } else if (activeTaskId() && kanbanData().tasks[activeTaskId()!] && !isTimerRunning()) {
        setCurrentTimeDisplay(formatTime(kanbanData().tasks[activeTaskId()!].time_spent_ms));
      } else if (!activeTaskId()) {
        setCurrentTimeDisplay(formatTime(0));
      }
    }, 1000);
    return () => clearInterval(interval);
  });

  const handleDoubleClick = async () => {
    const newExpandedState = !isExpanded();
    try {
      await invoke('toggle_expansion', { expanded: newExpandedState });
      setIsExpanded(newExpandedState);
      if (newExpandedState && !isStoreLoaded()) {
        loadDataFromStore();
      }
    } catch (error) {
      console.error("Ошибка изменения размера окна (Solid):", error);
    }
  };

  const handlePlayPause = async () => {
    if (!activeTaskId()) {
      alert("Пожалуйста, выберите задачу из списка 'В работе' или переместите задачу туда.");
      return;
    }
    const currentData = kanbanData();
    const taskToProcess = currentData.tasks[activeTaskId()!];
    if (!taskToProcess) {
      console.error("Активная задача не найдена в kanbanData (Solid)");
      return;
    }

    if (isTimerRunning()) {
      try {
        const pausedTask: Task | null = await invoke('pause_timer');
        setIsTimerRunning(false);
        if (pausedTask) {
          const updatedTasks = { ...currentData.tasks, [pausedTask.id]: pausedTask };
          const newData = { ...currentData, tasks: updatedTasks };
          setKanbanData(newData);
          setCurrentTimeDisplay(formatTime(pausedTask.time_spent_ms));
          await saveKanbanDataToStore(newData, activeTaskId());
        }
      } catch (e) {
        console.error("Ошибка приостановки таймера (Solid):", e);
      }
    } else {
      try {
        const startedTask: Task = await invoke('start_timer', { taskToStart: taskToProcess });
        setIsTimerRunning(true);
        const updatedTasks = { ...currentData.tasks, [startedTask.id]: startedTask };
        const newData = { ...currentData, tasks: updatedTasks };
        setKanbanData(newData);
      } catch (e) {
        console.error("Ошибка запуска таймера (Solid):", e);
      }
    }
  };

  const handleCreateTask = async () => {
    if (!newTaskContent().trim()) return;
    const newTaskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const newTask: Task = { id: newTaskId, content: newTaskContent(), time_spent_ms: 0 };

    const currentKbData = kanbanData();
    const newTasks = { ...currentKbData.tasks, [newTask.id]: newTask };
    const queueColumn = currentKbData.columns.queue;
    const newQueueTaskIds = [newTask.id, ...queueColumn.taskIds];
    const newQueueColumn = { ...queueColumn, taskIds: newQueueTaskIds };
    const newKbData = { ...currentKbData, tasks: newTasks, columns: { ...currentKbData.columns, queue: newQueueColumn } };

    setKanbanData(newKbData);
    setNewTaskContent('');
    await saveKanbanDataToStore(newKbData, activeTaskId());
  };

  const selectTaskForTimer = async (taskId: string) => {
    const currentKbData = kanbanData();
    if (isTimerRunning() && activeTaskId() !== taskId) {
      const currentlyActiveTask = currentKbData.tasks[activeTaskId()!];
      if (currentlyActiveTask) {
        const pausedTask: Task | null = await invoke('pause_timer');
        if (pausedTask) {
          setKanbanData(prev => {
            const newTasks = { ...prev.tasks, [pausedTask.id]: pausedTask };
            const updatedData = { ...prev, tasks: newTasks };
            // Сохраняем сразу, так как время предыдущей задачи обновилось, и мы меняем activeTaskId
            saveKanbanDataToStore(updatedData, taskId);
            return updatedData;
          });
        } else {
          // Если пауза не вернула задачу, все равно сохраняем новый activeTaskId
          await saveKanbanDataToStore(currentKbData, taskId);
        }
      } else {
        await saveKanbanDataToStore(currentKbData, taskId);
      }
    }

    setActiveTaskIdState(taskId);
    setIsTimerRunning(false);

    const taskToSelect = currentKbData.tasks[taskId];
    if (taskToSelect) {
      await invoke('sync_task_to_rust_db', { task: taskToSelect });
      setCurrentTimeDisplay(formatTime(taskToSelect.time_spent_ms));
      // Сохраняем, если activeTaskId изменился. Если это повторный клик, store уже должен быть актуален.
      if (activeTaskId() !== taskId || !isTimerRunning()) { // Добавил !isTimerRunning() для сохранения при первом выборе
        await saveKanbanDataToStore(currentKbData, taskId);
      }
    }
  };

  const handleHideToTray = async () => {
    try {
      await invoke('hide_window_to_tray');
      console.log("Hide to tray command invoked.");
    } catch (error) {
      console.error("Ошибка скрытия окна в трей (Solid):", error);
    }
  };

  const onDragStart = (event: DragEvent) => {
    setActiveDragItem(String(event.draggable.id));
  };

  // Вспомогательная функция для перемещения элементов в массиве
  function arrayMove<T>(array: T[], fromIndex: number, toIndex: number): T[] {
    const newArray = [...array];
    const [item] = newArray.splice(fromIndex, 1);
    newArray.splice(toIndex, 0, item);
    return newArray;
  }

  const onDragEnd = async (event: DragEvent) => {
    // Сбрасываем состояние активного перетаскиваемого элемента после завершения
    setActiveDragItem(null);

    // Получаем ID перетаскиваемого элемента и элемента, над которым завершилось перетаскивание
    const activeId = event.draggable ? String(event.draggable.id) : null;
    // overIdFromEvent может быть ID колонки или ID задачи
    const overIdFromEvent = event.droppable ? String(event.droppable.id) : null;

    console.log('onDragEnd: LOG 1 - activeId =', activeId, ', overIdFromEvent =', overIdFromEvent); // LOG 1

    // Если нет активного элемента или цели перетаскивания, просто сохраняем текущее состояние и выходим
    if (!activeId || !overIdFromEvent) {
      console.log('onDragEnd: LOG 2 - Нет activeId или overIdFromEvent, выход.'); // LOG 2
      await saveKanbanDataToStore(kanbanData(), activeTaskId());
      return;
    }

    // Получаем текущие данные канбан-доски
    let currentKbData = kanbanData();
    let sourceColumnId: string | undefined;

    // Находим исходную колонку задачи по ее ID
    for (const colId of currentKbData.columnOrder) {
      if (currentKbData.columns[colId].taskIds.includes(activeId)) {
        sourceColumnId = colId;
        break;
      }
    }

    // Если исходная колонка не найдена, выходим
    if (!sourceColumnId) {
      console.error("onDragEnd: LOG 3 - Исходная колонка для задачи не найдена:", activeId); // LOG 3
      await saveKanbanDataToStore(kanbanData(), activeTaskId());
      return;
    }
    console.log('onDragEnd: LOG 4 - sourceColumnId =', sourceColumnId); // LOG 4


    let destinationColumnId: string | undefined;
    // Это ID задачи, над которой закончили перетаскивание, если это не колонка
    let targetTaskIdForSort: string | undefined;

    // Определяем целевую колонку и, возможно, целевую задачу внутри нее
    if (currentKbData.columns[overIdFromEvent]) {
      // Если overIdFromEvent - это ID колонки, то задача брошена над колонкой
      destinationColumnId = overIdFromEvent;
      targetTaskIdForSort = undefined; // Целевой задачи нет
      console.log('onDragEnd: LOG 5 - overIdFromEvent - это колонка, destinationColumnId =', destinationColumnId); // LOG 5
    } else {
      // Если overIdFromEvent - это не ID колонки, считаем, что это ID задачи
      targetTaskIdForSort = overIdFromEvent;
      // Находим колонку, в которой находится целевая задача
      for (const colId of currentKbData.columnOrder) {
        if (currentKbData.columns[colId].taskIds.includes(targetTaskIdForSort)) {
          destinationColumnId = colId;
          break;
        }
      }
      console.log('onDragEnd: LOG 6 - overIdFromEvent - это задача, targetTaskIdForSort =', targetTaskIdForSort, ', destinationColumnId =', destinationColumnId); // LOG 6
    }

    // Если целевая колонка не найдена (невалидный overId), считаем перетаскивание невалидным
    if (!destinationColumnId) {
      console.warn(`onDragEnd: LOG 7 - Целевая колонка не найдена для overIdFromEvent: ${overIdFromEvent}. Перетаскивание отменено.`); // LOG 7
      await saveKanbanDataToStore(kanbanData(), activeTaskId());
      return;
    }
    console.log('onDragEnd: LOG 8 - destinationColumnId =', destinationColumnId); // LOG 8


    // Создаем рабочую копию данных канбан-доски для модификации
    let newKanbanData = { ...currentKbData };

    // Логика перетаскивания ВНУТРИ ТОЙ ЖЕ колонки
    if (sourceColumnId === destinationColumnId) {
      console.log('onDragEnd: LOG 9 - Перемещение внутри той же колонки.'); // LOG 9
      const column = { ...newKanbanData.columns[sourceColumnId] }; // Копируем колонку
      const taskIds = Array.from(column.taskIds); // Работаем с копией массива ID задач
      const oldIndex = taskIds.indexOf(activeId); // Исходный индекс задачи
      console.log('onDragEnd: LOG 10 - oldIndex =', oldIndex, ', taskIds (до) =', taskIds); // LOG 10


      // Определяем новый индекс задачи
      let newIndex = -1; // По умолчанию невалидный индекс

      if (targetTaskIdForSort && taskIds.includes(targetTaskIdForSort)) {
        // Если брошено над другой задачей в той же колонке
        // Новый индекс - это индекс целевой задачи.
        newIndex = taskIds.indexOf(targetTaskIdForSort);
        console.log('onDragEnd: LOG 11 - Брошено над задачей, targetTaskIdForSort =', targetTaskIdForSort, ', newIndex =', newIndex); // LOG 11

        // --- УТОЧНЕНИЕ ЛОГИКИ NEWINDEX ДЛЯ onDragEnd ---
        // В onDragEnd, newIndex для arrayMove - это индекс в массиве ПОСЛЕ удаления элемента.
        // Если мы бросили НАД элементом с индексом X в исходном массиве, и наш элемент был на oldIndex:
        // - Если oldIndex < X, то после удаления элемента на oldIndex, элемент, который был на X, теперь на X-1. Мы хотим вставить наш элемент на X-1.
        // - Если oldIndex > X, то после удаления элемента на oldIndex, элемент, который был на X, остается на X. Мы хотим вставить наш элемент на X.
        // - Если oldIndex === X, мы бросили над собой. Хотим остаться на месте. newIndex должен быть oldIndex.

        // Получаем индекс целевой задачи в исходном полном списке
        const targetIndexInFullList = currentKbData.columns[sourceColumnId].taskIds.indexOf(targetTaskIdForSort);
        console.log('onDragEnd: LOG 11a - targetIndexInFullList (в полном списке) =', targetIndexInFullList); // LOG 11a

        if (targetIndexInFullList !== -1) {
          if (oldIndex < targetIndexInFullList) {
            // Перетаскиваем вверх на позицию над целевой задачей
            newIndex = targetIndexInFullList - 1;
            console.log('onDragEnd: LOG 11b - oldIndex < targetIndexInFullList, newIndex =', newIndex); // LOG 11b
          } else if (oldIndex > targetIndexInFullList) {
            // Перетаскиваем вниз на позицию над целевой задачей
            newIndex = targetIndexInFullList;
            console.log('onDragEnd: LOG 11c - oldIndex > targetIndexInFullList, newIndex =', newIndex); // LOG 11c
          } else {
            // Брошено над собой
            newIndex = oldIndex; // Остаемся на той же позиции
            console.log('onDragEnd: LOG 11d - Брошено над собой, newIndex =', newIndex); // LOG 11d
          }
        } else {
          // Если targetTaskIdForSort не найден в исходном списке (не должно случиться),
          // это ошибка или бросок над невалидным элементом. Обрабатываем как ошибку.
          console.warn('onDragEnd: LOG 11e - targetTaskIdForSort не найден в исходном списке.'); // LOG 11e
          newIndex = oldIndex; // Возвращаем на исходную позицию как запасной вариант
        }


      } else {
        // Если брошено над самой колонкой (не над задачей)
        // Это означает перемещение в конец колонки
        // Индекс вставки в массиве без удаленного элемента будет равен его текущей длине.
        newIndex = taskIds.length;
        console.log('onDragEnd: LOG 12 - Брошено над колонкой, newIndex (конец) =', newIndex); // LOG 12
      }
      console.log('onDragEnd: LOG 13 - Рассчитанный newIndex (для arrayMove) =', newIndex); // LOG 13


      // Выполняем переупорядочивание, если исходный и новый индексы валидны и отличаются
      // Проверяем, что newIndex находится в допустимых пределах для arrayMove
      const finalNewIndex = Math.max(0, Math.min(newIndex, taskIds.length)); // taskIds.length - это размер массива после удаления 1 элемента
      console.log('onDragEnd: LOG 13a - Final newIndex (после проверки пределов) =', finalNewIndex); // LOG 13a


      if (oldIndex !== -1 && finalNewIndex !== -1 && oldIndex !== finalNewIndex) {
        console.log('onDragEnd: LOG 14 - Выполняем arrayMove.'); // LOG 14
        const reorderedTaskIds = arrayMove(taskIds, oldIndex, finalNewIndex); // Выполняем перемещение в массиве
        console.log('onDragEnd: LOG 15 - reorderedTaskIds =', reorderedTaskIds); // LOG 15

        // Обновляем колонку с новым порядком задач
        column.taskIds = reorderedTaskIds;

        // Обновляем объект kanbanData измененной колонкой
        newKanbanData.columns[sourceColumnId] = column;

        console.log(`onDragEnd: LOG 16 - Задача ${activeId} перемещена в колонке ${sourceColumnId} из позиции ${oldIndex} в позицию ${finalNewIndex}.`); // LOG 16
      } else {
        // Если брошено на ту же позицию или в невалидное место, не меняем порядок задач
        console.log(`onDragEnd: LOG 17 - Задача ${activeId} брошена в той же колонке ${sourceColumnId}, но позиция не изменилась или перетаскивание было невалидным.`); // LOG 17
        // В этом случае newKanbanData остается равным currentKbData, т.е. без изменений порядка.
      }

    } else {
      // Логика перетаскивания МЕЖДУ РАЗНЫМИ колонками (эта часть кажется более корректной)
      console.log('onDragEnd: LOG 18 - Перемещение между колонками.'); // LOG 18
      const sourceColumn = { ...newKanbanData.columns[sourceColumnId] }; // Копируем исходную колонку
      const destColumn = { ...newKanbanData.columns[destinationColumnId] }; // Копируем целевую колонку
      console.log('onDragEnd: LOG 19 - sourceColumn.taskIds (до) =', sourceColumn.taskIds); // LOG 19
      console.log('onDragEnd: LOG 20 - destColumn.taskIds (до) =', destColumn.taskIds); // LOG 20


      // Удаляем задачу из исходной колонки
      sourceColumn.taskIds = sourceColumn.taskIds.filter(id => id !== activeId);
      console.log('onDragEnd: LOG 21 - sourceColumn.taskIds (после удаления) =', sourceColumn.taskIds); // LOG 21


      // Добавляем задачу в целевую колонку
      let destTaskIds = Array.from(destColumn.taskIds); // Работаем с копией

      if (targetTaskIdForSort && destTaskIds.includes(targetTaskIdForSort)) {
        // Если брошено над другой задачей в целевой колонке, вставляем перед ней
        const overIndexInDest = destTaskIds.indexOf(targetTaskIdForSort);
        destTaskIds.splice(overIndexInDest, 0, activeId);
        console.log('onDragEnd: LOG 22 - Брошено над задачей в другой колонке, targetTaskIdForSort =', targetTaskIdForSort, ', overIndexInDest =', overIndexInDest); // LOG 22
      } else {
        // Если брошено над колонкой или над нераспознанным элементом, добавляем в конец
        destTaskIds.push(activeId);
        console.log('onDragEnd: LOG 23 - Брошено над колонкой в другой колонке, добавляем в конец.'); // LOG 23
      }
      destColumn.taskIds = destTaskIds;
      console.log('onDragEnd: LOG 24 - destColumn.taskIds (после добавления) =', destColumn.taskIds); // LOG 24


      // Обновляем объект kanbanData измененными исходной и целевой колонками
      newKanbanData.columns[sourceColumnId] = sourceColumn;
      newKanbanData.columns[destinationColumnId] = destColumn;

      console.log(`onDragEnd: LOG 25 - Задача ${activeId} перемещена из колонки ${sourceColumnId} в колонку ${destinationColumnId}.`); // LOG 25
    }

    // Обновляем Solid State и сохраняем в Store
    // Используем batch для атомарного обновления нескольких сигналов
    batch(async () => {
      setKanbanData(newKanbanData); // Обновляем основное состояние
      console.log('onDragEnd: LOG 26 - setKanbanData вызван с newKanbanData.'); // LOG 26
      console.log('onDragEnd: LOG 27 - kanbanData() после setKanbanData (может не сразу обновиться в этом логе) =', kanbanData()); // LOG 27


      // Логика таймера при смене колонки
      if (destinationColumnId === 'inProgress' && activeTaskId() !== activeId) {
        // Если задача перемещена В колонку "В работе" и это не текущая активная, выбираем ее
        console.log(`onDragEnd: LOG 28 - Задача ${activeId} перемещена в 'inProgress', выбираем ее.`); // LOG 28
        await selectTaskForTimer(activeId); // Эта функция обновит activeTaskIdState, isTimerRunning, currentTimeDisplay и сохранит в store
      } else if (sourceColumnId === 'inProgress' && destinationColumnId !== 'inProgress' && activeTaskId() === activeId) {
        // Если АКТИВНАЯ задача перемещена ИЗ колонки "В работе"
        console.log(`onDragEnd: LOG 29 - Активная задача ${activeId} перемещена из 'inProgress'.`); // LOG 29
        if (isTimerRunning()) {
          // Ставим таймер на паузу в Rust
          console.log('onDragEnd: LOG 30 - Таймер работает, ставим на паузу.'); // LOG 30
          const pausedTask: Task | null = await invoke('pause_timer');
          if (pausedTask) {
            console.log('onDragEnd: LOG 31 - pause_timer вернул задачу:', pausedTask); // LOG 31
            // Обновляем время в Solid State из результата Rust
            setKanbanData(prev => ({
              ...prev,
              tasks: { ...prev.tasks, [pausedTask.id]: pausedTask }
            }));
          } else {
            console.log('onDragEnd: LOG 32 - pause_timer не вернул задачу.'); // LOG 32
          }
        }
        // Сбрасываем статус активного таймера и выбранной задачи
        setIsTimerRunning(false);
        setActiveTaskIdState(null);
        setCurrentTimeDisplay(formatTime(0));
        console.log('onDragEnd: LOG 33 - Таймер сброшен.'); // LOG 33


        // Поскольку мы вручную сбросили состояние таймера, нужно явно сохранить в store
        await saveKanbanDataToStore(kanbanData(), activeTaskId()); // Передаем актуальное состояние (activeTaskId() теперь null)
        console.log('onDragEnd: LOG 34 - Состояние сохранено после сброса таймера.'); // LOG 34

      } else {
        // В остальных случаях (неактивная задача перемещена, перемещена внутри не-inProgress колонки)
        // Главное обновление состояния (setKanbanData) произошло в начале batch.
        // Просто сохраняем состояние. activeTaskId не меняется (или был null).
        console.log('onDragEnd: LOG 35 - Обычное перемещение, сохраняем состояние.'); // LOG 35
        await saveKanbanDataToStore(kanbanData(), activeTaskId()); // Передаем актуальное состояние
      }
    }); // Конец batch
    console.log('onDragEnd: LOG 36 - batch завершен.'); // LOG 36
  };


  const onDragOver = (event: DragEvent) => {
    const sourceTaskId = event.draggable ? String(event.draggable.id) : null;
    // overId - это ID элемента, над которым находится курсор (может быть ID колонки или задачи)
    const overId = event.droppable ? String(event.droppable.id) : null;

    console.log('onDragOver: LOG 1 - sourceTaskId =', sourceTaskId, ', overId =', overId);

    // Если нет перетаскиваемого элемента или цели, выходим
    if (!sourceTaskId || !overId) {
      console.log('onDragOver: LOG 2 - Нет sourceTaskId или overId, выход.');
      return;
    }

    let currentKbData = kanbanData(); // Получаем текущее состояние

    // --- Находим исходную колонку ---
    let sourceColId: string | undefined;
    for (const colId of currentKbData.columnOrder) {
      if (currentKbData.columns[colId].taskIds.includes(sourceTaskId)) {
        sourceColId = colId;
        break;
      }
    }
    if (!sourceColId) {
      console.log('onDragOver: LOG 3 - Исходная колонка не найдена, выход.');
      return; // Если исходная колонка не найдена, выходим
    }
    console.log('onDragOver: LOG 4 - sourceColId =', sourceColId);


    // --- Определяем целевую колонку и тип цели (колонка или задача) ---
    let actualDestinationColumnId: string | undefined;
    let overIsTask = false; // Флаг: находимся ли мы над задачей

    if (currentKbData.columns[overId]) {
      // overId - это ID колонки
      actualDestinationColumnId = overId;
      overIsTask = false;
      console.log('onDragOver: LOG 5 - overId - это колонка, actualDestinationColumnId =', actualDestinationColumnId);
    } else {
      // overId - это, вероятно, ID задачи. Находим ее колонку.
      overIsTask = true;
      for (const colId of currentKbData.columnOrder) {
        if (currentKbData.columns[colId].taskIds.includes(overId)) {
          actualDestinationColumnId = colId;
          break;
        }
      }
      console.log('onDragOver: LOG 6 - overId - это задача, overIsTask =', overIsTask, ', actualDestinationColumnId =', actualDestinationColumnId);
    }
    // Если целевая колонка не найдена (невалидный overId), выходим
    if (!actualDestinationColumnId) {
      console.log('onDragOver: LOG 7 - Целевая колонка не найдена, выход.');
      return;
    }
    console.log('onDragOver: LOG 8 - actualDestinationColumnId =', actualDestinationColumnId);


    // --- Определяем место вставки в целевой колонке для визуального превью ---

    const targetColumn = { ...currentKbData.columns[actualDestinationColumnId] }; // Копия целевой колонки
    // Получаем ПОЛНЫЙ список ID задач в целевой колонке
    let targetColumnTaskIds = Array.from(targetColumn.taskIds);
    console.log('onDragOver: LOG 9 - targetColumnTaskIds (полный) =', targetColumnTaskIds);


    // Удаляем ID перетаскиваемой задачи из этого списка, чтобы найти индекс в массиве БЕЗ нее
    const taskIdsWithoutSource = targetColumnTaskIds.filter(id => id !== sourceTaskId);
    console.log('onDragOver: LOG 10 - taskIdsWithoutSource =', taskIdsWithoutSource);


    let insertAt = taskIdsWithoutSource.length; // По умолчанию вставляем в конец (если над колонкой)
    console.log('onDragOver: LOG 11 - Начальный insertAt (конец) =', insertAt);


    // Если находимся над задачей И эта задача действительно есть в ПОЛНОМ списке целевой колонки
    if (overIsTask && targetColumnTaskIds.includes(overId)) {
      console.log('onDragOver: LOG 12a - overIsTask && targetColumnTaskIds.includes(overId) is true');

      // Находим индекс целевой задачи в списке БЕЗ перетаскиваемой задачи
      const indexInWithoutSource = taskIdsWithoutSource.indexOf(overId);
      console.log('onDragOver: LOG 12b - indexInWithoutSource =', indexInWithoutSource);

      if (indexInWithoutSource !== -1) {
        // Если целевая задача найдена в списке без перетаскиваемой, вставляем ПЕРЕД ней
        insertAt = indexInWithoutSource;
        console.log('onDragOver: LOG 12c - overId found in taskIdsWithoutSource, insertAt =', insertAt);
      } else {
        // Этот случай должен происходить только если overId === sourceTaskId.
        // В этом случае мы хотим, чтобы визуальное превью показывало задачу на ее текущей позиции.
        // Находим ее исходный индекс в полном списке и используем его.
        const sourceIndexInFullList = targetColumnTaskIds.indexOf(sourceTaskId);
        console.log('onDragOver: LOG 12d - overId === sourceTaskId, sourceIndexInFullList =', sourceIndexInFullList);
        if (sourceIndexInFullList !== -1) {
          insertAt = sourceIndexInFullList;
          console.log('onDragOver: LOG 12e - Using sourceIndexInFullList as insertAt =', insertAt);
        } else {
          // Запасной вариант, если что-то пошло не так
          insertAt = taskIdsWithoutSource.length;
          console.log('onDragOver: LOG 12f - Fallback to end, insertAt =', insertAt);
        }
      }

    } else if (actualDestinationColumnId === overId) {
      // Если находимся над самой колонкой (не над задачей), вставляем в конец
      insertAt = taskIdsWithoutSource.length;
      console.log('onDragOver: LOG 13 - overId - это колонка, insertAt (конец) =', insertAt);
    } else {
      // Крайний случай, когда overIsTask=false, но overId не является ID колонки. Не должно происходить.
      console.warn('onDragOver: LOG 14 - Неожиданный сценарий. overIsTask=false, но overId не колонка.', overId);
      insertAt = taskIdsWithoutSource.length; // Запасной вариант
    }


    // --- Обновляем состояние для отображения превью ---

    // Вставляем перетаскиваемую задачу в список ID задач целевой колонки в нужное место
    const updatedTargetTaskIds = [...taskIdsWithoutSource]; // Начинаем с массива без перетаскиваемой задачи
    // Проверяем, что insertAt находится в допустимых пределах
    const finalInsertAt = Math.max(0, Math.min(insertAt, updatedTargetTaskIds.length));
    updatedTargetTaskIds.splice(finalInsertAt, 0, sourceTaskId); // Вставляем ее в рассчитанное место

    console.log('onDragOver: LOG 15 - Final insertAt =', finalInsertAt, ', updatedTargetTaskIds =', updatedTargetTaskIds);


    // Обновляем объект целевой колонки новым порядком задач
    targetColumn.taskIds = updatedTargetTaskIds;

    // Создаем новые данные канбан-доски для обновления состояния
    let dataToSet = { ...currentKbData };

    // Если исходная колонка отличается от целевой, обновляем также исходную колонку
    // (удаляем из нее визуально перетаскиваемый элемент)
    if (sourceColId !== actualDestinationColumnId) {
      const sourceColumn = { ...currentKbData.columns[sourceColId] };
      sourceColumn.taskIds = sourceColumn.taskIds.filter(id => id !== sourceTaskId);
      dataToSet.columns[sourceColId] = sourceColumn;
      console.log('onDragOver: LOG 16 - Исходная колонка обновлена для превью:', sourceColumn.taskIds);
    }
    // Обновляем целевую колонку в новых данных
    dataToSet.columns[actualDestinationColumnId] = targetColumn;
    console.log('onDragOver: LOG 17 - Целевая колонка обновлена для превью:', targetColumn.taskIds);


    // Атомарно обновляем состояние Solid.js для реактивности
    batch(() => {
      setKanbanData(dataToSet);
    });
    console.log('onDragOver: LOG 18 - setKanbanData вызван.');
  };

  return (
    <DragDropProvider onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver}>
      <DragDropSensors />
      <div
        class={`app-container ${isExpanded() ? 'expanded' : 'collapsed'}`}
        onDblClick={!isExpanded() ? handleDoubleClick : undefined}
        data-tauri-drag-region
      >
        <Show when={!isExpanded()} fallback={
          <div class="expanded-view">
            <div class="toolbar" data-tauri-drag-region>
              <span>Kanban Доска</span>
              <div> {/* Wrapper for buttons */}
                <button onClick={handleDoubleClick} class="collapse-button" title="Свернуть">❐</button>
              </div>
            </div>
            <Show when={isStoreLoaded()} fallback={<div style={{ "padding": "20px", "text-align": "center" }}>Загрузка данных...</div>}>
              <div class="task-creation">
                <input type="text" value={newTaskContent()} onInput={(e) => setNewTaskContent(e.currentTarget.value)} placeholder="Новая задача..." onKeyPress={(e) => e.key === 'Enter' && handleCreateTask()} />
                <button onClick={handleCreateTask}>Добавить Задачу</button>
              </div>
              <div class="kanban-board">
                <For each={kanbanData().columnOrder}>
                  {(columnId) => {
                    const column = () => kanbanData().columns[columnId];
                    const tasksInColumn = () => column()?.taskIds.map(taskId => kanbanData().tasks[taskId]).filter(task => task) || [];
                    return (
                      <Show when={column()}>
                        <DroppableColumn column={column()!} tasks={tasksInColumn()} activeTaskId={activeTaskId()} onSelectTask={selectTaskForTimer} onDeleteTask={deleteTask} />
                      </Show>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        }>
          <div class="widget-view">
            <Show when={isStoreLoaded()} fallback={<div>Загрузка...</div>}>
              <div class="task-name-display">
                <Show when={activeTaskId() && kanbanData().tasks[activeTaskId()!]} fallback={"Нет задачи"}>
                  <span
                    class={`current-task-title${isTimerRunning() ? " active" : ""}`}
                  >
                    {kanbanData().tasks[activeTaskId()!].content}
                  </span>
                </Show>
              </div>
              <div class="widget-controls-row">
                <button
                  onClick={handlePlayPause}
                  class={`control-button round cyberpunk ${isTimerRunning() ? "pause" : "play"}`}
                  disabled={!activeTaskId() && !isTimerRunning()}
                  title={isTimerRunning() ? "Пауза" : "Старт"}
                >
                  {isTimerRunning() ? (
                    // Пауза
                    <svg width="28" height="28" viewBox="0 0 28 28" class="cyber-icon">
                      <rect x="6" y="6" width="4" height="16" rx="2" fill="#fff" stroke="#ff00cc" stroke-width="2" />
                      <rect x="18" y="6" width="4" height="16" rx="2" fill="#fff" stroke="#ff00cc" stroke-width="2" />
                    </svg>
                  ) : (
                    // Плей
                    <svg width="28" height="28" viewBox="0 0 28 28" class="cyber-icon">
                      <polygon points="8,6 22,14 8,22" fill="#fff" stroke="#0ff" stroke-width="2" />
                    </svg>
                  )}
                </button>
                <div class="time-display">{currentTimeDisplay()}</div>
                <button onClick={handleHideToTray} class="widget-hide-button" title="Скрыть в трей">🗕</button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <DragOverlay>
        <Show when={activeDragItem() && kanbanData().tasks[activeDragItem()!]}>
          <div class="task-card dragging">
            {kanbanData().tasks[activeDragItem()!].content}
          </div>
        </Show>
      </DragOverlay>
    </DragDropProvider>
  );
}

const formatTime = (ms: number): string => {
  if (isNaN(ms) || ms < 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

export default App;