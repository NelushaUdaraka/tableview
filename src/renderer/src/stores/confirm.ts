/**
 * A yes-or-no question asked over the window, in place of the browser's
 * `confirm()` — which blocks the renderer and looks like nothing else here.
 *
 * For what the other dialogs do not cover: Truncate and Drop from the tree on a
 * connection that does not confirm its writes, and deleting a saved connection.
 * Each of those cannot be undone, so the dialog treats every question as one
 * that cannot: Cancel has the focus, and the button that goes ahead is red.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Question {
  /** Above the title, naming what it is about: `Table`. */
  kicker: string
  /** The question: `Drop sales.orders?` */
  title: string
  /** What saying yes does, in a sentence or two. */
  message: string
  /** The button that goes ahead: `Drop`. */
  action: string
}

export interface PendingQuestion extends Question {
  resolve: (proceed: boolean) => void
}

export const useConfirmStore = defineStore('confirm', () => {
  const question = ref<PendingQuestion | null>(null)

  /** Resolves true once the user says to go ahead, false on anything else. */
  function ask(next: Question): Promise<boolean> {
    // A question already on screen is withdrawn rather than left unanswered.
    question.value?.resolve(false)
    return new Promise((resolve) => {
      question.value = { ...next, resolve }
    })
  }

  function answer(proceed: boolean): void {
    const current = question.value
    question.value = null
    current?.resolve(proceed)
  }

  return { question, ask, answer }
})
