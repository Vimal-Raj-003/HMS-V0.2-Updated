import { defineStories } from '../stories/story.js';
import { TaskList, type ClinicalTask } from './task-list.js';

const labels = {
  heading: 'My tasks',
  window: {
    overdue: 'Overdue',
    now: 'Due now',
    'next-2h': 'Next 2 hours',
    later: 'Later today',
  },
  emptyWindow: {
    overdue: 'Nothing overdue.',
    now: 'Nothing due in the next 15 minutes.',
    'next-2h': 'Nothing in the next 2 hours.',
    later: 'Nothing later today.',
  },
  complete: 'Done',
  skip: 'Skip',
  highAlert: 'High alert',
  none: 'No tasks assigned to you on this ward.',
};

const tasks: readonly ClinicalTask[] = [
  {
    id: 't1',
    title: 'Enoxaparin 40 mg — subcutaneous',
    subject: 'Bed 12 · R. Nair',
    dueLabel: '35 min late',
    dueInMinutes: -35,
    highAlert: true,
  },
  {
    id: 't2',
    title: 'Paracetamol 1 g — oral',
    subject: 'Bed 07 · M. Iyer',
    dueLabel: '5 min late',
    dueInMinutes: -5,
  },
  {
    id: 't3',
    title: 'Observations — NEWS2',
    subject: 'Bed 12 · R. Nair',
    dueLabel: 'due 14:10',
    dueInMinutes: 8,
  },
  {
    id: 't4',
    title: 'Amoxicillin 500 mg — oral',
    subject: 'Bed 03 · K. Menon',
    dueLabel: 'due 15:30',
    dueInMinutes: 88,
  },
  {
    id: 't5',
    title: 'Wound dressing change',
    subject: 'Bed 07 · M. Iyer',
    dueLabel: 'due 18:00',
    dueInMinutes: 240,
  },
];

export const taskListStories = defineStories({
  slug: 'task-list',
  component: 'TaskList',
  spec: '§5.2 #31',
  summary: 'What this nurse owes this ward, grouped by how late it is.',
  stories: [
    {
      id: 'four-windows',
      name: 'All four due windows',
      rationale:
        'Handed in arbitrary order and grouped by the component, so a re-sort cannot move an overdue task out of the overdue group. The 35-minute-late dose sorts above the 5-minute-late one.',
      render: () => (
        <TaskList labels={labels} tasks={tasks} onComplete={() => undefined} onSkip={() => undefined} />
      ),
    },
    {
      id: 'high-alert',
      name: 'High-alert medicine',
      rationale:
        'Anticoagulants, insulin and narcotics carry a persistent marker — a left rule and a word, not a colour — because these are the rows where a wrong administration is not recoverable.',
      render: () => (
        <TaskList labels={labels} tasks={[tasks[0] as ClinicalTask]} onComplete={() => undefined} />
      ),
    },
    {
      id: 'nothing-overdue',
      name: 'Nothing overdue',
      rationale:
        'The overdue group is rendered even when it is empty. An absent group and an empty one say the same thing, but only the stated one can be trusted at a glance.',
      render: () => (
        <TaskList
          labels={labels}
          tasks={tasks.filter((t) => t.dueInMinutes >= 0)}
          onComplete={() => undefined}
        />
      ),
    },
    {
      id: 'read-only',
      name: 'Read-only reviewer',
      degraded: true,
      rationale:
        'Degraded capability rather than degraded data: an auditor or a doctor viewing another ward gets the list with no actions at all, rather than buttons that fail on click.',
      render: () => <TaskList labels={labels} tasks={tasks.slice(0, 3)} />,
    },
    {
      id: 'empty',
      name: 'No tasks at all',
      degraded: true,
      rationale:
        'Names the ward, so an empty list reads as "you have nothing here" rather than as a screen that failed to load.',
      render: () => <TaskList labels={labels} tasks={[]} />,
    },
  ],
});
