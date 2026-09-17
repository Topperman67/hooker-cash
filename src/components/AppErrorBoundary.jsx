import { Component } from 'react'

export default class AppErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="app-recovery" role="alert">
        <img src="/brand/hookbrew/hookbrew-icon.png" alt="" width="64" height="64" />
        <h1>Let’s get you back to Hookbrew.</h1>
        <p>This page couldn’t load. Check your connection, then reload to try again.</p>
        <p>
          Your saved draft and pending transaction records stay on this device. Reloading won’t send
          another transaction.
        </p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </main>
    )
  }
}
