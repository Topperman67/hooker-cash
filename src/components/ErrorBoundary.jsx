import { Component } from 'react'
import { isChunkLoadError, retryFailedPages } from './recovery.js'

// Wraps the routes. `resetKey` (the pathname) clears the error when the visitor navigates, so one
// broken page cannot take over every other route until a reload.
export default class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.retry()
  }
  retry = () => {
    retryFailedPages()
    this.setState({ error: null })
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const chunk = isChunkLoadError(error)
    return (
      <div className="wrap">
        <div className="empty" role="alert">
          <h3>{chunk ? 'This page could not load' : 'This page hit an error'}</h3>
          <p>
            {chunk
              ? 'Quant Pad may have been updated since this tab was opened, or the connection dropped. Try again, or reload to get the latest version.'
              : 'Something went wrong while showing this page. Try again, or reload if it keeps happening.'}
          </p>
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" onClick={this.retry}>
              Try again
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    )
  }
}
