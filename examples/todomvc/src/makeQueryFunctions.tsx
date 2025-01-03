export function makeQueryFunctions({ ready, ledger }): {
  fetchAllLists: () => Promise<any>;
  fetchListWithTodos: (_id: any) => Promise<{ list: any; todos: any }>;
  addList: (title: any) => Promise<any>;
  addTodo: (listId: any, title: any) => Promise<any>;
  toggle: ({ completed, ...doc }: { [x: string]: any; completed: any }) => Promise<any>;
  destroy: ({ _id }: { _id: any }) => Promise<any>;
  updateTitle: (doc: any, title: any) => Promise<any>;
  clearCompleted: (listId: any) => Promise<void>;
} {
  const fetchAllLists = async () => {
    const lists = ready && ledger.allLists ? await ledger.allLists.query({ range: ["list", "listx"] }) : { rows: [] };
    return lists.rows.map(({ value }) => value);
  };

  const fetchListWithTodos = async (_id) => {
    if (!ready || !ledger.todosByList) return Promise.resolve({ list: { title: "", type: "list", _id: "" }, todos: [] });

    const list = await ledger.get(_id);
    const todos = await ledger.todosByList.query({
      range: [
        [_id, "0"],
        [_id, "9"],
      ],
    });
    return { list, todos: todos.rows.map((row) => row.value) };
  };

  const addList = async (title) => {
    return ready && (await ledger.put({ title, type: "list" }));
  };

  const addTodo = async (listId, title) => {
    return (
      ready &&
      (await ledger.put({
        completed: false,
        title,
        listId,
        type: "todo",
        createdAt: new Date().toISOString(),
      }))
    );
  };

  const toggle = async ({ completed, ...doc }) => {
    return ready && (await ledger.put({ completed: !completed, ...doc }));
  };

  const destroy = async ({ _id }) => {
    return ready && (await ledger.del(_id));
  };

  const updateTitle = async (doc, title) => {
    doc.title = title;
    return ready && (await ledger.put(doc));
  };

  const clearCompleted = async (listId) => {
    const result =
      ready &&
      (await ledger.todosByList.query({
        range: [
          [listId, "1"],
          [listId, "x"],
        ],
      }));

    const todos = result.rows.map((row) => row.value);
    const todosToDelete = todos.filter((todo) => todo.completed);
    for (const todoToDelete of todosToDelete) {
      await ledger.del(todoToDelete._id);
    }
  };
  return {
    fetchAllLists,
    fetchListWithTodos,
    addList,
    addTodo,
    toggle,
    destroy,
    updateTitle,
    clearCompleted,
  };
}
