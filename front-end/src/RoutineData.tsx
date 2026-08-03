export type RoutineData = {
  id: number
  name: string
  isGlobalOff?: boolean | undefined
  actions?: {
    bulbId: number
    actionType: 'brightness' | 'color'
    value?: number | string
  }[]
}

export const routineData: RoutineData[] = [
  {
    id: 1,
    name: 'Kitchen',
    actions: [
      {
        bulbId: 2,
        actionType: 'color',
        value: '#ffffff',
      },
      {
        bulbId: 3,
        actionType: 'color',
        value: '#ffffff',
      },
    ]
  },
  {
    id: 2,
    name: 'Red',
    actions: [
      {
        bulbId: 1,
        actionType: 'color',
        value: '#ff0000',
      },
      {
        bulbId: 1,
        actionType: 'brightness',
        value: 100,
      },
    ]
  },
  {
    id: 3,
    name: 'Orange',
    actions: [
      {
        bulbId: 1,
        actionType: 'color',
        value: '#ff680a',
      },
      {
        bulbId: 1,
        actionType: 'brightness',
        value: 100,
      },
    ]
  },
  {
    id: 4,
    name: 'Maximum',
    isGlobalOff: false,
  },
  {
    id: 5,
    name: 'Sleep',
    isGlobalOff: true,
  }
]
