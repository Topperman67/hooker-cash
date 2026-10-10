import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="wrap">
        <div className="empty">
          <h3>This page hit an error</h3>
          <p>{this.state.error.message || 'Something went wrong while rendering.'}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    )
  }
}
