import { Modal } from './Modal';
import { TodoList } from './TodoList';
import { isTodoDone, type TodoItem } from '../subagents';

interface Props {
  todos: TodoItem[];
  onClose: () => void;
}

export function TaskListModal({ todos, onClose }: Props) {
  const total = todos.length;
  const done = todos.filter((t) => isTodoDone(t.status)).length;

  return (
    <Modal title={`Tasks (${done}/${total} done)`} onClose={onClose}>
      <TodoList todos={todos} />
    </Modal>
  );
}
