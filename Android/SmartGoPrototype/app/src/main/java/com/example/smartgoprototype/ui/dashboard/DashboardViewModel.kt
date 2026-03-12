package com.example.smartgoprototype.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.repository.AuthRepository
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val routeRepository: RouteRepository,
    private val authRepository: AuthRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(DashboardUiState(isInitialLoading = true))
    val uiState: StateFlow<DashboardUiState> = _uiState

    // One-shot event: navigate to login after successful sign-out.
    private val _signOutEvent = Channel<Unit>(Channel.BUFFERED)
    val signOutEvent = _signOutEvent.receiveAsFlow()

    init { fetchRoutes(isRefresh = false) }

    fun refresh() {
        fetchRoutes(isRefresh = true)
    }

    fun signOut() {
        viewModelScope.launch {
            authRepository.signOut().onSuccess {
                _signOutEvent.send(Unit)
            }.onFailure { e ->
                _uiState.value = _uiState.value.copy(errorMessage = e.message ?: "Sign out failed")
            }
        }
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
                _uiState.value = _uiState.value.copy(
                    isInitialLoading = false,
                    isRefreshing = false,
                    errorMessage = e.message ?: "Failed to load routes"
                )
            }
        }
    }
}
