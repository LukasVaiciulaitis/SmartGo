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

    private val _uiState = MutableStateFlow(DashboardUiState(isLoading = true))
    val uiState: StateFlow<DashboardUiState> = _uiState

    // Initial load when the ViewModel is first created.
    init { loadRoutes() }

    /**
     * Reloads routes (e.g., pull-to-refresh or when returning from "Add Route").
     */
    fun loadRoutes() {
        _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)
        viewModelScope.launch {
            try {
                val routes = routeRepository.getRoutes()
                _uiState.value = _uiState.value.copy(isLoading = false, routes = routes, errorMessage = null)
            } catch (e: Exception) {
                // Keep error messaging user-friendly; the exception message is used as best-effort detail.
                _uiState.value = _uiState.value.copy(isLoading = false, errorMessage = e.message ?: "Failed to load routes")
            }
        }
    }
}
