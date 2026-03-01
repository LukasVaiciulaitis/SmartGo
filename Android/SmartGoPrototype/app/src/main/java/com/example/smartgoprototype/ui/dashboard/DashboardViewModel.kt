package com.example.smartgoprototype.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for dashboard screen.
 *
 * Responsibilities:
 * - Loads routes from [RouteRepository] and exposes a simple (temporary) loading/content/error state.
 *
 */
@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val routeRepository: RouteRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(DashboardUiState(isInitialLoading = true))
    val uiState: StateFlow<DashboardUiState> = _uiState

    // Initial load when the ViewModel is first created.
    init { loadInitial() }

    /**
     * Performs first-screen load.
     */
    fun loadInitial() {
        fetchRoutes(isRefresh = false)
    }

    /**
     * Pull-to-refresh / explicit user refresh.
     */
    fun refresh() {
        fetchRoutes(isRefresh = true)
    }

    private fun fetchRoutes(isRefresh: Boolean) {
        _uiState.value = _uiState.value.copy(
            isInitialLoading = !isRefresh,
            isRefreshing = isRefresh,
            errorMessage = null
        )

        viewModelScope.launch {
            try {
                val routes = routeRepository.getRoutes()
                _uiState.value = _uiState.value.copy(
                    isInitialLoading = false,
                    isRefreshing = false,
                    routes = routes,
                    errorMessage = null
                )
            } catch (e: Exception) {
                // Keep error messaging user-friendly; the exception message is used as best-effort detail.
                _uiState.value = _uiState.value.copy(
                    isInitialLoading = false,
                    isRefreshing = false,
                    errorMessage = e.message ?: "Failed to load routes"
                )
            }
        }
    }
}
